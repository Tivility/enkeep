/**
 * Tenant and Server Process Pool with Reference Counting and Idle Eviction
 *
 * Enforces:
 * - Process pool keyed by user + contributionId + version (NOT session-based)
 * - Strict per-tenant / per-server process isolation
 * - Reference counting for concurrent tool invocations
 * - Idle timer auto-reap (30 minutes default, reaps unused stdio child processes)
 * - Maximum concurrent processes limit per tenant and across the entire platform
 * - Clean asynchronous process tree teardown (SIGTERM -> SIGKILL fallback)
 *
 * @module @enkeep/platform-service-mcp/pool/process-pool
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpErrorCode, McpServiceError } from '../errors.js';
import { filterChildEnvironment } from '../security/env-filter.js';
import { validateExecutable } from '../security/executable-guard.js';
import { createHardenedHttpTransport } from '../transport/http-client.js';
import {
  DEFAULT_INIT_TIMEOUT_MS,
  type McpHttpServerDescriptor,
  type McpResolvedCredentials,
  type McpServerDescriptor,
  type McpStdioServerDescriptor,
} from '../types.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_MAX_PROCESSES_PER_TENANT = 10;
export const DEFAULT_MAX_TOTAL_PROCESSES = 50;

export interface PooledConnection {
  readonly tenantKey: string; // `${userId}:${contributionId}:${version}`
  readonly userId: string;
  readonly serverId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly descriptor: McpServerDescriptor;
  readonly client: Client;
  readonly transport: Transport;
  pid?: number;
  refCount: number;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  isClosing: boolean;
}

export interface ProcessPoolOptions {
  readonly idleTimeoutMs?: number;
  readonly maxProcessesPerTenant?: number;
  readonly maxTotalProcesses?: number;
  readonly envWhitelist?: readonly string[];
  readonly globalAllowlist?: readonly string[];
  readonly allowLocalHttpForTesting?: boolean;
  readonly onProcessSpawn?: (userId: string, serverId: string, pid?: number) => void;
  readonly onProcessExit?: (userId: string, serverId: string, pid?: number) => void;
}

/**
 * Helper to terminate a process and its process group cleanly.
 */
export async function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!pid) return;

  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {}
      }
    } else {
      process.kill(pid, signal);
    }
  } catch {}

  // Force SIGKILL fallback
  setTimeout(() => {
    try {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}
  }, 1000).unref();
}

export class McpProcessPool {
  private readonly connections = new Map<string, PooledConnection>();
  private readonly idleTimeoutMs: number;
  private readonly maxProcessesPerTenant: number;
  private readonly maxTotalProcesses: number;
  private isDisposed = false;

  constructor(private readonly options: ProcessPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxProcessesPerTenant = options.maxProcessesPerTenant ?? DEFAULT_MAX_PROCESSES_PER_TENANT;
    this.maxTotalProcesses = options.maxTotalProcesses ?? DEFAULT_MAX_TOTAL_PROCESSES;
  }

  tenantKey(userId: string, descriptor: McpServerDescriptor): string {
    const contribId = descriptor.contributionId || descriptor.id;
    const version = descriptor.version || '1.0.0';
    return `${userId}:${contribId}:${version}`;
  }

  getActiveCount(userId?: string, serverId?: string): number {
    if (!userId && !serverId) return this.connections.size;
    let count = 0;
    for (const conn of this.connections.values()) {
      if (userId && conn.userId !== userId) continue;
      if (serverId && conn.serverId !== serverId) continue;
      count++;
    }
    return count;
  }

  /**
   * Acquires a connected Client instance for a tenant and server descriptor.
   */
  async acquire(
    userId: string,
    descriptor: McpServerDescriptor,
    ephemeralCredentials: McpResolvedCredentials = {},
    signal?: AbortSignal,
  ): Promise<{ client: Client; release: () => void }> {
    if (this.isDisposed) {
      throw new McpServiceError('Process pool is disposed', {
        code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
      });
    }

    const key = this.tenantKey(userId, descriptor);
    let conn = this.connections.get(key);

    if (conn && !conn.isClosing) {
      // Clear idle timer
      if (conn.idleTimer) {
        clearTimeout(conn.idleTimer);
        conn.idleTimer = undefined;
      }
      conn.refCount++;
      conn.lastUsed = Date.now();
      return {
        client: conn.client,
        release: () => this.releaseConnection(key),
      };
    }

    // Check concurrency limits
    const tenantCount = this.getActiveCount(userId);
    if (tenantCount >= this.maxProcessesPerTenant) {
      throw new McpServiceError(
        `Exceeded maximum allowed concurrent MCP processes (${this.maxProcessesPerTenant}) for tenant "${userId}"`,
        {
          code: McpErrorCode.MCP_PROCESS_LIMIT_EXCEEDED,
          details: { userId, currentCount: tenantCount, max: this.maxProcessesPerTenant },
        },
      );
    }

    if (this.connections.size >= this.maxTotalProcesses) {
      throw new McpServiceError(
        `Host-wide MCP process limit (${this.maxTotalProcesses}) exceeded`,
        {
          code: McpErrorCode.MCP_PROCESS_LIMIT_EXCEEDED,
          details: { totalCount: this.connections.size, max: this.maxTotalProcesses },
        },
      );
    }

    // Connect new client
    const newConn = await this.createConnection(userId, descriptor, ephemeralCredentials, signal);
    newConn.refCount = 1;
    newConn.lastUsed = Date.now();
    this.connections.set(key, newConn);

    return {
      client: newConn.client,
      release: () => this.releaseConnection(key),
    };
  }

  private async createConnection(
    userId: string,
    descriptor: McpServerDescriptor,
    ephemeralCredentials: McpResolvedCredentials,
    signal?: AbortSignal,
  ): Promise<PooledConnection> {
    const key = this.tenantKey(userId, descriptor);
    const contribId = descriptor.contributionId || descriptor.id;
    const version = descriptor.version || '1.0.0';
    let transport: Transport;

    if (descriptor.transport === 'stdio') {
      const stdioDesc = descriptor as McpStdioServerDescriptor;
      const argv = stdioDesc.argv ?? stdioDesc.args ?? [];

      // Validate command
      const { resolvedCommand, resolvedArgs } = validateExecutable(
        stdioDesc.command,
        argv,
        {
          globalAllowlist: this.options.globalAllowlist,
          serverAllowlist: stdioDesc.allowlistedExecutables,
          packageRoots: stdioDesc.packageRoots,
        },
      );

      // Filter environment variables
      const cleanEnv = filterChildEnvironment(
        process.env,
        stdioDesc.env ?? {},
        ephemeralCredentials.env ?? {},
        { customAllowed: this.options.envWhitelist },
      );

      transport = new StdioClientTransport({
        command: resolvedCommand,
        args: resolvedArgs,
        env: cleanEnv,
        cwd: stdioDesc.cwd || process.cwd(),
        stderr: 'pipe',
      });
    } else {
      const httpDesc = descriptor as McpHttpServerDescriptor;
      transport = await createHardenedHttpTransport({
        descriptor: httpDesc,
        ephemeralHeaders: ephemeralCredentials.headers,
        allowLocalHttpForTesting: this.options.allowLocalHttpForTesting,
        signal,
      });
    }

    const client = new Client(
      {
        name: `enkeep-mcp-gateway/${descriptor.id}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    const initTimeout = descriptor.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    try {
      await client.connect(transport, { timeout: initTimeout });
    } catch (err) {
      if ((transport as any)._process?.pid) {
        await killProcessTree((transport as any)._process.pid, 'SIGKILL');
      }
      throw new McpServiceError(
        `Failed to initialize MCP client for server "${descriptor.id}": ${err instanceof Error ? err.message : String(err)}`,
        {
          code: McpErrorCode.MCP_INITIALIZE_FAILED,
          cause: err,
        },
      );
    }

    const pid = (transport as any)._process?.pid || (transport as any).pid;
    if (pid) {
      this.options.onProcessSpawn?.(userId, descriptor.id, pid);
    }

    const pooled: PooledConnection = {
      tenantKey: key,
      userId,
      serverId: descriptor.id,
      contributionId: contribId,
      version,
      descriptor,
      client,
      transport,
      pid,
      refCount: 0,
      lastUsed: Date.now(),
      isClosing: false,
    };

    // Attach exit listener if stdio
    if ((transport as any)._process) {
      const child = (transport as any)._process;
      child.once('exit', (code: number | null, sig: string | null) => {
        this.options.onProcessExit?.(userId, descriptor.id, pid);
        const active = this.connections.get(key);
        if (active && active.transport === transport) {
          void this.destroyConnection(key);
        }
      });
    }

    return pooled;
  }

  private releaseConnection(key: string): void {
    const conn = this.connections.get(key);
    if (!conn) return;

    conn.refCount = Math.max(0, conn.refCount - 1);
    conn.lastUsed = Date.now();

    if (conn.refCount === 0 && !conn.idleTimer && !this.isDisposed) {
      conn.idleTimer = setTimeout(() => {
        void this.destroyConnection(key);
      }, this.idleTimeoutMs);
      conn.idleTimer.unref();
    }
  }

  async destroyConnection(key: string): Promise<void> {
    const conn = this.connections.get(key);
    if (!conn) return;

    this.connections.delete(key);
    conn.isClosing = true;

    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = undefined;
    }

    try {
      await conn.client.close();
    } catch {}

    if (conn.pid) {
      await killProcessTree(conn.pid, 'SIGKILL');
    }
  }

  async close(): Promise<void> {
    this.isDisposed = true;
    const keys = Array.from(this.connections.keys());
    await Promise.allSettled(keys.map((k) => this.destroyConnection(k)));
    this.connections.clear();
  }
}
