/**
 * Host MCP Manager Implementation
 *
 * Implements McpGatewayPort:
 * - Dynamic server discovery via catalog provider callback
 * - Reconcile active contribution set dynamically
 * - Ephemeral credential resolution via CredentialResolverPort (zero DB/log/model leak)
 * - Per-tenant process pooling (user + contributionId + version), refcount, and idle eviction
 * - Circuit breaker tracking (3 failures / 60s) & automatic recovery
 * - Space binding visibility controls
 * - Normalized tool registry & collision resolution (${serverSlug}__${tool})
 * - Execution timeouts (15s default), AbortSignal cancellation, output bounds (4MB default), and sanitization
 * - Audit logging and metrics emission without secret/payload leakage
 *
 * @module @enkeep/platform-service-mcp/manager
 */

import { isMcpServiceError, McpErrorCode, McpServiceError, sanitizeMcpError } from './errors.js';
import { CircuitBreaker } from './pool/circuit-breaker.js';
import { McpProcessPool } from './pool/process-pool.js';
import {
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_RESET_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  type CredentialResolverPort,
  type McpAuditHook,
  type McpCatalogProvider,
  type McpContext,
  type McpContributionManifest,
  type McpCredentialRef,
  type McpEffectivePlan,
  type McpEffectivePlanProvider,
  type McpGatewayPort,
  type McpManagerOptions,
  type McpResolvedCredentials,
  type McpServerDescriptor,
  type McpServerHealth,
  type McpToolCallResult,
  type McpToolDefinition,
  type McpUsageMetricsCallback,
} from './types.js';
import { validateMcpContributionManifest } from './security/executable-guard.js';
import { normalizeInputSchema, sanitizeToolCallResult } from './security/sanitizer.js';
import {
  buildCanonicalToolName,
  parseCanonicalToolName,
  toContributionKeySlug,
} from './naming.js';

export class HostMcpManager implements McpGatewayPort {
  private readonly catalogProvider?: McpCatalogProvider;
  private staticServers: Map<string, McpServerDescriptor>;
  private readonly credentialResolver?: CredentialResolverPort;
  private readonly effectivePlanProvider?: McpEffectivePlanProvider;
  private readonly processPool: McpProcessPool;
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly activeInvocations = new Map<string, AbortController>();
  private readonly onAudit?: McpAuditHook;
  private readonly onMetric?: McpUsageMetricsCallback;
  private readonly circuitFailureThreshold: number;
  private readonly circuitResetTimeoutMs: number;
  private readonly defaultToolTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly requireAdminApproval: boolean;
  private isDisposed = false;

  constructor(options: McpManagerOptions = {}) {
    this.catalogProvider = options.catalogProvider;
    this.credentialResolver = options.credentialResolver;
    this.effectivePlanProvider = options.effectivePlanProvider;
    this.onAudit = options.onAudit;
    this.onMetric = options.onMetric;
    this.circuitFailureThreshold = options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.circuitResetTimeoutMs = options.circuitResetTimeoutMs ?? DEFAULT_CIRCUIT_RESET_TIMEOUT_MS;
    this.defaultToolTimeoutMs = options.defaultToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.requireAdminApproval = options.requireAdminApproval !== false;

    // Validate and register initial static servers
    this.staticServers = new Map<string, McpServerDescriptor>();
    if (options.servers) {
      for (const raw of options.servers) {
        const validated = validateMcpContributionManifest(raw as McpContributionManifest, {
          requireAdminApproval: this.requireAdminApproval,
          globalAllowlist: options.executableAllowlist,
        });
        this.staticServers.set(validated.id, validated);
      }
    }

    this.processPool = new McpProcessPool({
      idleTimeoutMs: options.idleTimeoutMs,
      maxProcessesPerTenant: options.maxProcessesPerTenant,
      maxTotalProcesses: options.maxTotalProcesses,
      envWhitelist: options.envWhitelist,
      globalAllowlist: options.executableAllowlist,
      allowLocalHttpForTesting: options.allowLocalHttpForTesting,
      onProcessSpawn: (userId, serverId) => {
        void this.emitAudit({
          timestamp: Date.now(),
          eventType: 'server_spawn',
          serverId,
          userId,
          success: true,
        });
      },
      onProcessExit: (userId, serverId) => {
        void this.emitAudit({
          timestamp: Date.now(),
          eventType: 'server_exit',
          serverId,
          userId,
          success: true,
        });
      },
    });
  }

  private getCircuitBreaker(serverId: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(serverId);
    if (!cb) {
      cb = new CircuitBreaker(serverId, {
        failureThreshold: this.circuitFailureThreshold,
        resetTimeoutMs: this.circuitResetTimeoutMs,
        onStateChange: (id, state) => {
          void this.emitAudit({
            timestamp: Date.now(),
            eventType: 'circuit_state_change',
            serverId: id,
            userId: 'system',
            success: state === 'CLOSED',
          });
        },
      });
      this.circuitBreakers.set(serverId, cb);
    }
    return cb;
  }

  private async emitAudit(event: Parameters<McpAuditHook>[0]): Promise<void> {
    if (!this.onAudit) return;
    try {
      await this.onAudit(event);
    } catch {}
  }

  private async emitMetric(
    userId: string,
    serverId: string,
    toolName: string | undefined,
    durationMs: number,
    isError: boolean,
  ): Promise<void> {
    if (!this.onMetric) return;
    try {
      await this.onMetric({
        userId,
        serverId,
        toolName,
        callCount: 1,
        totalDurationMs: durationMs,
        errorCount: isError ? 1 : 0,
      });
    } catch {}
  }

  /**
   * Reconciles the active static / extension contribution set dynamically.
   */
  async reconcile(contributions: readonly (McpServerDescriptor | McpContributionManifest)[]): Promise<void> {
    if (this.isDisposed) {
      throw new McpServiceError('Host MCP Manager is disposed', {
        code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
      });
    }

    const nextServers = new Map<string, McpServerDescriptor>();
    for (const raw of contributions) {
      const validated = validateMcpContributionManifest(raw as McpContributionManifest, {
        requireAdminApproval: this.requireAdminApproval,
      });
      nextServers.set(validated.id, validated);
    }

    // Determine removed servers and clear their circuit breakers
    for (const [oldId] of this.staticServers) {
      if (!nextServers.has(oldId)) {
        this.circuitBreakers.delete(oldId);
      }
    }

    this.staticServers = nextServers;
  }

  /**
   * Resolves the list of active server descriptors for the given context.
   * Applies space binding visibility, admin approval checks, and turn effective plans.
   */
  private async resolveServers(context: McpContext): Promise<readonly McpServerDescriptor[]> {
    const fromCatalog = this.catalogProvider ? await this.catalogProvider(context) : [];
    const all = [...Array.from(this.staticServers.values()), ...fromCatalog];

    // Deduplicate by ID
    const byId = new Map<string, McpServerDescriptor>();
    for (const s of all) {
      byId.set(s.id, s);
    }

    let servers = Array.from(byId.values());

    // 1. Space binding visibility check
    if (context.spaceId) {
      servers = servers.filter((s) => {
        if (!s.spaceIds || s.spaceIds.length === 0) return true;
        return s.spaceIds.includes(context.spaceId!);
      });
    }

    // 2. Admin approval check for user extensions
    if (this.requireAdminApproval) {
      servers = servers.filter((s) => {
        const source = s.source ?? 'builtin';
        if (source === 'user-extension' || source === 'extension') {
          return Boolean(s.adminApproved);
        }
        return true;
      });
    }

    // 3. Apply per-turn effective plan if provided
    let plan: McpEffectivePlan | null | undefined;
    if (this.effectivePlanProvider) {
      plan = await this.effectivePlanProvider(context);
    }

    if (!plan) return servers;

    const enabled = plan.enabledServers ? new Set(plan.enabledServers) : null;
    const disabled = plan.disabledServers ? new Set(plan.disabledServers) : null;

    return servers.filter((s) => {
      if (disabled && disabled.has(s.id)) return false;
      if (enabled && !enabled.has(s.id)) return false;
      return true;
    });
  }

  /**
   * Resolves ephemeral credentials for a server descriptor and user.
   * Invariant: Credentials are used only for child process env or HTTP request headers.
   */
  private async resolveServerCredentials(
    userId: string,
    descriptor: McpServerDescriptor,
  ): Promise<McpResolvedCredentials> {
    if (!this.credentialResolver) {
      return {};
    }

    const refsToResolve: McpCredentialRef[] = [];

    // Collect from credentialRefs
    if (descriptor.credentialRefs) {
      for (const ref of descriptor.credentialRefs) {
        if (typeof ref === 'string') {
          refsToResolve.push({ id: ref });
        } else if (ref && typeof ref === 'object') {
          refsToResolve.push(ref);
        }
      }
    }

    // Collect from envRefs if array of strings or McpCredentialRef
    if (descriptor.envRefs && Array.isArray(descriptor.envRefs)) {
      for (const ref of descriptor.envRefs) {
        if (typeof ref === 'string') {
          refsToResolve.push({ id: ref });
        } else if (ref && typeof ref === 'object') {
          refsToResolve.push(ref);
        }
      }
    }

    if (refsToResolve.length === 0) {
      return {};
    }

    const mergedEnv: Record<string, string> = {};
    const mergedHeaders: Record<string, string> = {};

    for (const ref of refsToResolve) {
      const creds = await this.credentialResolver.resolveCredentials(userId, ref);
      if (creds?.env) {
        Object.assign(mergedEnv, creds.env);
      }
      if (creds?.headers) {
        Object.assign(mergedHeaders, creds.headers);
      }
    }

    return { env: mergedEnv, headers: mergedHeaders };
  }

  /**
   * Lists all available normalized tools.
   */
  async listTools(context: McpContext): Promise<readonly McpToolDefinition[]> {
    if (this.isDisposed) {
      throw new McpServiceError('Host MCP Manager is disposed', {
        code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
      });
    }

    const servers = await this.resolveServers(context);
    const definitions: McpToolDefinition[] = [];

    // Collect tools from all healthy/permitted servers
    for (const server of servers) {
      const cb = this.getCircuitBreaker(server.id);
      if (cb.getState() === 'OPEN') {
        continue; // Skip servers whose circuit breaker is open
      }

      try {
        const credentials = await this.resolveServerCredentials(context.userId, server);
        const { client, release } = await this.processPool.acquire(
          context.userId,
          server,
          credentials,
          context.signal,
        );

        try {
          const res = await client.listTools({});
          const tools = res.tools ?? [];

          for (const t of tools) {
            const canonicalName = buildCanonicalToolName(server.contributionId || server.id, t.name);
            definitions.push({
              name: canonicalName,
              description: t.description,
              inputSchema: normalizeInputSchema(t.inputSchema),
              serverId: server.id,
              originalName: t.name,
            });
          }
          cb.recordSuccess();
        } finally {
          release();
        }
      } catch (err) {
        cb.recordFailure(err);
      }
    }

    // Validate unique canonical tool names across servers; collision fails listing
    const seenNames = new Set<string>();
    for (const d of definitions) {
      if (seenNames.has(d.name)) {
        throw new McpServiceError(
          `Tool name collision detected for "${d.name}". Multiple servers offer conflicting canonical names.`,
          {
            code: McpErrorCode.MCP_INTERNAL_ERROR,
            details: { canonicalName: d.name },
          },
        );
      }
      seenNames.add(d.name);
    }

    // Apply tool allowlist/denylist from effective plan
    let plan: McpEffectivePlan | null | undefined;
    if (this.effectivePlanProvider) {
      plan = await this.effectivePlanProvider(context);
    }

    if (!plan) return definitions;

    const allowed = plan.toolAllowlist ? new Set(plan.toolAllowlist) : null;
    const denied = plan.toolDenylist ? new Set(plan.toolDenylist) : null;

    return definitions.filter((t) => {
      if (denied && (denied.has(t.name) || denied.has(t.originalName))) return false;
      if (allowed && !allowed.has(t.name) && !allowed.has(t.originalName)) return false;
      return true;
    });
  }

  /**
   * Invokes an MCP tool by its canonical public name.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    context: McpContext,
  ): Promise<McpToolCallResult> {
    if (this.isDisposed) {
      throw new McpServiceError('Host MCP Manager is disposed', {
        code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
      });
    }

    // Strictly validate and parse canonical tool name (must be mcp__<slug>__<rawToolName>)
    const parsed = parseCanonicalToolName(name);
    if (!parsed) {
      throw new McpServiceError(
        `Tool "${name}" is not a valid canonical MCP tool name. Expected format "mcp__<serverSlug>__<rawToolName>"`,
        {
          code: McpErrorCode.MCP_BAD_REQUEST,
          details: { requestedName: name },
        },
      );
    }

    const { slug: requestedSlug, rawToolName: requestedRawName } = parsed;
    const startTime = Date.now();
    let targetServer: McpServerDescriptor | undefined;
    const originalToolName = requestedRawName;

    const controller = new AbortController();
    const requestKey = context.requestId ? `${context.userId}:${context.requestId}` : undefined;
    if (requestKey) {
      this.activeInvocations.set(requestKey, controller);
    }

    const onAbort = () => {
      controller.abort(context.signal?.reason || new Error('Aborted by client signal'));
    };

    if (context.signal) {
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (controller.signal.aborted) {
      if (requestKey) {
        this.activeInvocations.delete(requestKey);
      }
      throw new McpServiceError('Tool invocation was cancelled before execution', {
        code: McpErrorCode.MCP_TOOL_CANCELLED,
        cause: controller.signal.reason,
      });
    }

    try {
      // 1. Resolve target server and tool name
      const servers = await this.resolveServers(context);

      if (controller.signal.aborted) {
        throw new McpServiceError('Tool invocation was cancelled during server resolution', {
          code: McpErrorCode.MCP_TOOL_CANCELLED,
          cause: controller.signal.reason,
        });
      }

      // Map contribution key / server descriptor by slug
      targetServer = servers.find((s) => {
        const slug = toContributionKeySlug(s.contributionId || s.id);
        return slug === requestedSlug || s.id === requestedSlug;
      });

      if (!targetServer) {
        throw new McpServiceError(
          `Tool "${name}" was not found on any active MCP server (server "${requestedSlug}" not found)`,
          {
            code: McpErrorCode.MCP_TOOL_NOT_FOUND,
            details: { requestedName: name, serverSlug: requestedSlug },
          },
        );
      }

      const cb = this.getCircuitBreaker(targetServer.id);
      cb.checkExecutionPermitted();

      // 2. Audit tool call start
      await this.emitAudit({
        timestamp: startTime,
        eventType: 'tool_call',
        serverId: targetServer.id,
        toolName: name,
        userId: context.userId,
        sessionId: context.sessionId,
        success: true,
      });

      let isError = false;
      let errorCode: string | undefined;

      try {
        // 3. Resolve ephemeral credentials
        const credentials = await this.resolveServerCredentials(context.userId, targetServer);

        // 4. Acquire client from process pool
        const { client, release } = await this.processPool.acquire(
          context.userId,
          targetServer,
          credentials,
          controller.signal,
        );

        try {
          // 5. Execute tool call with timeout (15s default) and cancellation
          const timeout = targetServer.toolTimeoutMs ?? this.defaultToolTimeoutMs;
          const maxOutputBytes = targetServer.maxOutputBytes ?? this.defaultMaxOutputBytes;

          const timeoutId = setTimeout(() => {
            controller.abort(
              new McpServiceError(`Tool "${name}" timed out after ${timeout}ms`, {
                code: McpErrorCode.MCP_TOOL_TIMEOUT,
              }),
            );
          }, timeout);

          try {
            if (controller.signal.aborted) {
              const reason = controller.signal.reason;
              if (isMcpServiceError(reason)) throw reason;
              throw new McpServiceError('Tool invocation was cancelled before execution', {
                code: McpErrorCode.MCP_TOOL_CANCELLED,
                cause: reason,
              });
            }

            const callPromise = client.callTool(
              {
                name: originalToolName,
                arguments: args,
              },
              undefined,
              { signal: controller.signal },
            );

            // Race against abort signal
            const rawResult = await new Promise<any>((resolve, reject) => {
              const onSignalAbort = () => {
                const reason = controller.signal.reason;
                if (isMcpServiceError(reason)) {
                  reject(reason);
                } else {
                  reject(
                    new McpServiceError(
                      reason instanceof Error ? reason.message : 'Tool execution cancelled by AbortSignal',
                      {
                        code: McpErrorCode.MCP_TOOL_CANCELLED,
                        cause: reason,
                      },
                    ),
                  );
                }
              };

              if (controller.signal.aborted) {
                onSignalAbort();
                return;
              }

              controller.signal.addEventListener('abort', onSignalAbort, { once: true });

              callPromise
                .then((res) => {
                  controller.signal.removeEventListener('abort', onSignalAbort);
                  resolve(res);
                })
                .catch((err) => {
                  controller.signal.removeEventListener('abort', onSignalAbort);
                  reject(err);
                });
            });

            // 6. Sanitize and bound output (4MB default)
            const sanitized = sanitizeToolCallResult(rawResult, maxOutputBytes);
            cb.recordSuccess();

            const durationMs = Date.now() - startTime;
            await this.emitAudit({
              timestamp: Date.now(),
              eventType: 'tool_result',
              serverId: targetServer.id,
              toolName: name,
              userId: context.userId,
              sessionId: context.sessionId,
              durationMs,
              success: !sanitized.isError,
            });

            await this.emitMetric(context.userId, targetServer.id, name, durationMs, Boolean(sanitized.isError));
            return sanitized;
          } finally {
            clearTimeout(timeoutId);
          }
        } finally {
          release();
        }
      } catch (err) {
        isError = true;
        cb.recordFailure(err);
        const sanitizedErr = sanitizeMcpError(err, `Execution of tool "${name}" failed`);
        errorCode = sanitizedErr.code;

        const durationMs = Date.now() - startTime;
        await this.emitAudit({
          timestamp: Date.now(),
          eventType: 'tool_error',
          serverId: targetServer.id,
          toolName: name,
          userId: context.userId,
          sessionId: context.sessionId,
          durationMs,
          success: false,
          errorCode,
        });

        await this.emitMetric(context.userId, targetServer.id, name, durationMs, true);
        throw sanitizedErr;
      }
    } finally {
      if (requestKey) {
        this.activeInvocations.delete(requestKey);
      }
      if (context.signal) {
        context.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * Returns health status of all known servers.
   */
  async checkHealth(context: McpContext): Promise<readonly McpServerHealth[]> {
    const servers = await this.resolveServers(context);
    const results: McpServerHealth[] = [];

    for (const server of servers) {
      const cb = this.getCircuitBreaker(server.id);
      const state = cb.getState();
      const failures = cb.getConsecutiveFailures();
      const lastError = cb.getLastError();
      const activeProcesses = this.processPool.getActiveCount(context.userId, server.id);

      let status: McpServerHealth['status'] = 'healthy';
      if (state === 'OPEN') {
        status = 'unhealthy';
      } else if (state === 'HALF_OPEN' || failures > 0) {
        status = 'degraded';
      }

      results.push({
        serverId: server.id,
        status,
        circuitState: state,
        consecutiveFailures: failures,
        lastError,
        lastProbeTime: Date.now(),
        activeProcesses,
      });
    }

    return results;
  }

  /**
   * Alias for checkHealth.
   */
  async health(context: McpContext): Promise<readonly McpServerHealth[]> {
    return this.checkHealth(context);
  }

  /**
   * Cancels an in-flight tool invocation by requestId within tenant context.
   */
  async cancel(params: { requestId: string; context: McpContext }): Promise<void> {
    const requestKey = `${params.context.userId}:${params.requestId}`;
    const controller = this.activeInvocations.get(requestKey);
    if (controller) {
      controller.abort(
        new McpServiceError(`Tool invocation "${params.requestId}" was cancelled by client request`, {
          code: McpErrorCode.MCP_TOOL_CANCELLED,
        }),
      );
      this.activeInvocations.delete(requestKey);
    }
  }

  /**
   * Closes all connections and child processes.
   */
  async close(): Promise<void> {
    this.isDisposed = true;
    for (const controller of this.activeInvocations.values()) {
      controller.abort(
        new McpServiceError('Host MCP Manager is closing', {
          code: McpErrorCode.MCP_TOOL_CANCELLED,
        }),
      );
    }
    this.activeInvocations.clear();
    await this.processPool.close();
    this.circuitBreakers.clear();
  }

  /**
   * Alias for close.
   */
  async dispose(): Promise<void> {
    return this.close();
  }
}
