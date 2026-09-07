/**
 * MCP Governance Service & Lifecycle Orchestration
 *
 * Implements:
 * 1. McpGovernanceService on Cordis context (`ctx.mcpGovernance`).
 * 2. Single canonical `mountActivationPlan(agentCtx, plan, options)` method.
 * 3. Fetches visible tool schemas via ONE canonical `GET /api/mcp/tools?sessionId=...`.
 * 4. Strict schema security, depth/size limits, and anti-prompt injection shielding.
 * 5. Deterministic tool naming with collision failure enforcement.
 * 6. Dynamic registration into `agentCtx.tools` with complete disposer tracking.
 * 7. Truthful health reporting (`mcpConfigured`, `mcpOperational`, counts).
 * 8. Clean teardown with zero leaks.
 *
 * @module @enkeep/dsh-mcp-governance/service
 */

import { Service, Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
  ExtensionActivationPlan,
  ExtensionMcpContributionActivation,
  McpGovernanceOptions,
  McpMountHandle,
  McpHealthStatus,
  McpServerHealth,
  RawMcpTool,
  ListMcpToolsResponse,
  McpPlatformClientService,
  ToolsRegistryService,
} from './types.js';
import { sanitizeUntrustedDescription, validateAndSanitizeInputSchema } from './schema-security.js';
import { resolveToolRisk } from './approval-policy.js';
import { createMcpToolExecutor } from './executor.js';
import { resolveCallerScope } from './scope.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawMcpTool(value: unknown): value is RawMcpTool {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim() !== '';
}

export class McpGovernanceService extends Service {
  static inject = [];
  private activeMounts = new Map<string, McpMountHandle>();
  private lastKnownHealth: McpHealthStatus = {
    mcpConfigured: false,
    mcpOperational: true,
    serverCount: 0,
    toolCount: 0,
    servers: [],
  };

  constructor(ctx: Context) {
    super(ctx, 'mcpGovernance');
  }

  /**
   * Consumes ExtensionActivationPlan mcp contributions and mounts them onto an Agent's scoped context.
   * If no enabled MCP contributions are present, returns an empty disposer handle immediately.
   *
   * @param agentCtx - Scoped Cordis context for the active Agent
   * @param plan - ExtensionActivationPlan containing mcp contributions
   * @param options - Governance options including PlatformClient and boundaries
   * @returns McpMountHandle with registration details and cleanup disposer
   */
  async mountActivationPlan(
    agentCtx: Context,
    plan?: ExtensionActivationPlan | null,
    options: McpGovernanceOptions = {}
  ): Promise<McpMountHandle> {
    const registeredTools = new Map<string, ToolDefinition>();
    const disposers: Array<() => void> = [];
    const serverHealths = new Map<string, McpServerHealth>();

    // 1. Filter active MCP contributions
    const mcpContributions: ExtensionMcpContributionActivation[] = Array.isArray(plan?.mcp)
      ? plan.mcp.filter((c) => c.enabled !== false)
      : Array.isArray(plan?.contributions)
      ? (plan.contributions.filter((c) => c.kind === 'mcp' && c.enabled !== false) as ExtensionMcpContributionActivation[])
      : [];

    // If no active MCP contributions in plan, return empty handle immediately
    if (mcpContributions.length === 0) {
      return {
        registeredTools,
        serverHealths,
        dispose: async () => {},
      };
    }

    const client = options.platformClient ?? this.resolvePlatformClient(agentCtx);
    const maxInlineBytes = options.maxInlineBytes ?? 65_536;
    const maxSchemaDepth = options.maxSchemaDepth ?? 16;
    const maxSchemaSizeBytes = options.maxSchemaSizeBytes ?? 262_144;

    // 2. Derive authoritative caller scope (sessionId, userId, spaceId)
    const scope = resolveCallerScope(
      options.sessionId ? { sessionId: options.sessionId, spaceId: options.spaceId, userId: options.userId } : agentCtx,
      agentCtx
    );

    // Initialize server health entries from active contributions
    for (const contrib of mcpContributions) {
      serverHealths.set(contrib.contributionId, {
        serverId: contrib.contributionId,
        serverName: contrib.name,
        status: 'operational',
        toolsCount: 0,
        registeredTools: [],
        lastSyncedAt: new Date().toISOString(),
      });
    }

    let rawTools: readonly RawMcpTool[] = [];
    let fetchError: string | undefined;

    // 3. ONE canonical GET /api/mcp/tools?sessionId=...
    if (client && typeof client.request === 'function') {
      try {
        const resp = await client.request<ListMcpToolsResponse>('/api/mcp/tools', {
          method: 'GET',
          query: { sessionId: scope.sessionId },
          timeoutMs: options.defaultTimeoutMs ?? 30_000,
        });

        const payload = resp.data ?? resp.body;
        if (isRecord(payload) && Array.isArray(payload.tools)) {
          rawTools = payload.tools.filter(isRawMcpTool);
        } else if (isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.tools)) {
          rawTools = payload.data.tools.filter(isRawMcpTool);
        } else if (Array.isArray(payload)) {
          rawTools = payload.filter(isRawMcpTool);
        } else {
          fetchError = `Platform returned status ${resp.status || 500} for /api/mcp/tools`;
        }
      } catch (err: unknown) {
        fetchError = err instanceof Error ? err.message : String(err);
      }
    } else {
      fetchError = 'PlatformClient service is unavailable';
    }

    if (fetchError) {
      for (const [id, health] of serverHealths.entries()) {
        serverHealths.set(id, {
          ...health,
          status: 'unreachable',
          error: fetchError,
        });
      }

      this.updateHealthState(mcpContributions.length, 0, serverHealths);

      return {
        registeredTools,
        serverHealths,
        dispose: async () => {},
      };
    }

    let totalTools = 0;
    const toolsService = this.resolveToolsService(agentCtx);

    // 4. Register visible tools into ToolsRegistry
    for (const rawTool of rawTools) {
      // Reject tools requiring unsupported task protocol
      if (rawTool.execution?.taskSupport === 'required') {
        continue;
      }

      const publicName = rawTool.name;

      // Tool name collisions fail plan activation immediately (fail-closed)
      if (registeredTools.has(publicName)) {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {}
        }
        throw new Error(
          `FAIL-CLOSED: Tool name collision detected for "${publicName}". Plan activation failed.`
        );
      }

      // Secure schema & sanitize untrusted descriptions
      const sanitizedDesc = sanitizeUntrustedDescription(rawTool.description);
      const sanitizedParams = validateAndSanitizeInputSchema(
        rawTool.inputSchema,
        maxSchemaDepth,
        maxSchemaSizeBytes
      );

      // Evaluate risk and approval requirement (P1: all calls require approval)
      const risk = resolveToolRisk(rawTool);

      // Build ToolDefinition
      const toolDef: ToolDefinition = {
        name: publicName,
        description: sanitizedDesc,
        parameters: sanitizedParams,
        output: {
          schema: {
            type: 'object',
            properties: {
              content: { type: 'array', items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render: (_args: unknown, value: unknown) => {
            const res = isRecord(value) ? value : {};
            const textBlocks = Array.isArray(res.content)
              ? res.content
                  .map((b: unknown) =>
                    isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
                  )
                  .filter(Boolean)
              : [];
            return [{ type: 'text', text: textBlocks.join('\n') || '(no content)' }];
          },
        },
        isConcurrencySafe: () => risk.isConcurrencySafe,
        timeoutMs: options.defaultTimeoutMs ?? 60_000,
        execute: createMcpToolExecutor(agentCtx, {
          client: client!,
          rawTool,
          publicName,
          serverName: rawTool.serverId ?? rawTool.contributionId,
          risk,
          spaceId: options.spaceId ?? scope.spaceId,
          spacePath: options.spacePath,
          userId: options.userId ?? scope.userId,
          maxInlineBytes,
          timeoutMs: options.defaultTimeoutMs ?? 60_000,
        }),
      };

      // Register on agentCtx.tools
      if (toolsService && typeof toolsService.register === 'function') {
        try {
          const dispose = toolsService.register(toolDef);
          if (typeof dispose === 'function') {
            disposers.push(dispose);
            registeredTools.set(publicName, toolDef);
            totalTools++;

            // Update per-server tool tracking
            const serverKey = rawTool.contributionId ?? rawTool.serverId;
            if (serverKey && serverHealths.has(serverKey)) {
              const prev = serverHealths.get(serverKey)!;
              serverHealths.set(serverKey, {
                ...prev,
                toolsCount: prev.toolsCount + 1,
                registeredTools: [...prev.registeredTools, publicName],
              });
            }
          }
        } catch (regErr: unknown) {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {}
          }
          const msg = regErr instanceof Error ? regErr.message : String(regErr);
          throw new Error(`Failed to register tool "${publicName}" in ToolsRegistry: ${msg}`);
        }
      }
    }

    // 5. Record audit event on session if available
    const session = scope.agent?.session;
    if (session && typeof session.append === 'function') {
      try {
        session.append('mcp/plan-applied', {
          planVersion: plan?.generation,
          serverIds: mcpContributions.map((s) => s.contributionId),
          serverNames: mcpContributions.map((s) => s.name),
          totalToolsRegistered: totalTools,
        });
      } catch {
        // Audit log is best-effort
      }
    }

    // 6. Update health state
    this.updateHealthState(mcpContributions.length, totalTools, serverHealths);

    const handle: McpMountHandle = {
      registeredTools,
      serverHealths,
      dispose: async () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {}
        }
        registeredTools.clear();
      },
    };

    const mountKey = `${options.spaceId || 'root'}:${plan?.generation || Date.now()}`;
    this.activeMounts.set(mountKey, handle);

    return handle;
  }

  /**
   * Resolves the PlatformClient from Context.
   */
  private resolvePlatformClient(ctx: Context): McpPlatformClientService | undefined {
    return (
      ctx.get('platformClient') ??
      (ctx as unknown as { root?: { get?: (name: string) => McpPlatformClientService | undefined } }).root?.get?.('platformClient') ??
      (ctx as unknown as { platformClient?: McpPlatformClientService }).platformClient
    );
  }

  /**
   * Resolves the ToolsRegistryService from Context.
   */
  private resolveToolsService(ctx: Context): ToolsRegistryService | undefined {
    return (
      ctx.get('tools') ??
      (ctx as unknown as { tools?: ToolsRegistryService }).tools
    );
  }

  /**
   * Updates internal health metrics.
   */
  private updateHealthState(
    configuredServerCount: number,
    totalTools: number,
    serverHealths: Map<string, McpServerHealth>
  ): void {
    const allServers = Array.from(serverHealths.values());
    const isOperational =
      allServers.length === 0 || allServers.every((s) => s.status === 'operational');

    this.lastKnownHealth = {
      mcpConfigured: configuredServerCount > 0,
      mcpOperational: isOperational,
      serverCount: configuredServerCount,
      toolCount: totalTools,
      servers: allServers,
    };
  }

  /**
   * Returns the current truthful MCP health status.
   */
  getHealthStatus(): McpHealthStatus {
    return { ...this.lastKnownHealth };
  }

  /**
   * Disposes all active mounts and releases resources.
   */
  async disposeAll(): Promise<void> {
    for (const mount of this.activeMounts.values()) {
      try {
        await mount.dispose();
      } catch {}
    }
    this.activeMounts.clear();
  }
}

export default McpGovernanceService;
