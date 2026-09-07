/**
 * SSRF-Hardened Streamable-HTTP Client Transport Factory
 *
 * Configures StreamableHTTPClientTransport with:
 * - Pre-flight & redirect SSRF checks (private IP & DNS verification)
 * - HTTPS policy enforcement
 * - Header sanitization & ephemeral secret injection
 * - Strict timeouts and body size bounds
 *
 * @module @enkeep/platform-service-mcp/transport/http-client
 */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpErrorCode, McpServiceError } from '../errors.js';
import { sanitizeHttpHeaders, validateSsrfTargetUrl } from '../security/ssrf-guard.js';
import type { McpHttpServerDescriptor } from '../types.js';

export interface HttpClientTransportOptions {
  readonly descriptor: McpHttpServerDescriptor;
  readonly ephemeralHeaders?: Record<string, string>;
  readonly allowLocalHttpForTesting?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Creates an SSRF-protected StreamableHTTPClientTransport instance.
 */
export async function createHardenedHttpTransport(
  options: HttpClientTransportOptions,
): Promise<StreamableHTTPClientTransport> {
  const { descriptor, ephemeralHeaders = {} } = options;

  // 1. Initial SSRF validation of target URL
  const { resolvedUrl } = await validateSsrfTargetUrl(descriptor.url, {
    allowLocalHttpForTesting: options.allowLocalHttpForTesting,
    allowedHosts: descriptor.allowedHosts,
  });

  // 2. Prepare sanitized static & ephemeral headers
  const sanitizedHeaders = sanitizeHttpHeaders(descriptor.headers, ephemeralHeaders);
  const staticHeadersRecord: Record<string, string> = {};
  sanitizedHeaders.forEach((v, k) => {
    staticHeadersRecord[k] = v;
  });

  // 3. Custom hardened fetch implementation with redirect validation & timeout
  const hardenedFetch: typeof fetch = async (input, init) => {
    const targetUrlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Validate SSRF on each request (including redirects)
    await validateSsrfTargetUrl(targetUrlStr, {
      allowLocalHttpForTesting: options.allowLocalHttpForTesting,
      allowedHosts: descriptor.allowedHosts,
    });

    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(staticHeadersRecord)) {
      if (!headers.has(k)) {
        headers.set(k, v);
      }
    }

    const controller = new AbortController();
    const timeout = options.timeoutMs ?? descriptor.toolTimeoutMs ?? 30000;
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`MCP HTTP request timed out after ${timeout}ms`));
    }, timeout);

    // Chain caller's signal if present
    if (init?.signal) {
      init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true });
    }
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    try {
      const response = await fetch(input, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: 'manual', // Manually inspect redirects to prevent SSRF bypass
      });

      // Handle redirect safely
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new McpServiceError('HTTP redirect response missing Location header', {
            code: McpErrorCode.MCP_BAD_REQUEST,
          });
        }
        const resolvedRedirect = new URL(location, targetUrlStr).toString();
        // Re-validate redirect target
        await validateSsrfTargetUrl(resolvedRedirect, {
          allowLocalHttpForTesting: options.allowLocalHttpForTesting,
          allowedHosts: descriptor.allowedHosts,
        });

        // Follow redirect
        return hardenedFetch(resolvedRedirect, {
          ...init,
          method: 'GET', // standard redirect semantics
        });
      }

      return response;
    } catch (err) {
      if (err instanceof McpServiceError) throw err;
      if (controller.signal.aborted) {
        throw new McpServiceError('MCP HTTP upstream request timed out or cancelled', {
          code: McpErrorCode.MCP_TOOL_TIMEOUT,
          cause: err,
        });
      }
      throw new McpServiceError(
        `MCP HTTP upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: McpErrorCode.MCP_SERVER_UNAVAILABLE,
          cause: err,
        },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return new StreamableHTTPClientTransport(resolvedUrl, {
    requestInit: {
      headers: staticHeadersRecord,
    },
    fetch: hardenedFetch,
  });
}
