/**
 * LLM Proxy Stream Handler for Platform Host
 *
 * Implements StreamHandler for kind: 'llm' over stdio tunnel.
 * Resolves provider from `/llm/<providerKey>/...` path prefix against platform memory provider table.
 * Whitelists upstream hosts against DSH deployment configuration (`gw.example.com`),
 * replaces in-container placeholder credentials (Authorization / x-api-key) with real token from platform .env,
 * streams SSE responses chunk-by-chunk,
 * and fail-closes with 503 if configuration or token is missing without leaking tokens.
 *
 * @module @enkeep/runtime-runner/tunnel/llm-proxy
 */

import path from 'node:path';
import os from 'node:os';
import { Duplex, PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamHandler, StreamMetadata } from './contract.js';
import type {
  DshParsedProvider,
  DshDeploymentConfig,
} from '../config/dsh-config-loader.js';
import { loadDshDeploymentConfig } from '../config/dsh-config-loader.js';

import type { FallbackTarget } from '../transport/types.js';

export const LLM_STREAM_KIND = 'llm';
export const ALLOWED_DEEPSEEK_HOST = 'api.deepseek.com';
export const DEEPSEEK_BASE_ORIGIN = 'https://api.deepseek.com';

export type { FallbackTarget };

export interface ModelRoutingPort {
  canExecute(provider: string, model: string): { allowed: boolean; state: string; reason?: string };
  recordHealth(input: {
    provider: string;
    model: string;
    latencyMs: number;
    statusCode: number;
    success: boolean;
    errorType?: string | null;
  }): Promise<unknown> | unknown;
  getEffectiveFallbackChain?(userId?: string, sessionId?: string): Promise<FallbackTarget[]> | FallbackTarget[];
}

export interface LlmProxyOptions {
  /** Optional override for API key */
  apiKey?: string;
  /** Optional base origin for upstream */
  upstreamOrigin?: string;
  /** In-memory providers dictionary */
  providers?: Record<string, DshParsedProvider>;
  /** In-memory tokens dictionary (e.g. { CPA_TOKEN: '...' }) */
  tokens?: Record<string, string>;
  /** Allowed hostnames for upstream requests (e.g. ['gw.example.com']) */
  allowedHosts?: string[];
  /** Optional custom fetch implementation for testing */
  fetchImpl?: typeof fetch;
  /** Optional loaded deployment config */
  deploymentConfig?: DshDeploymentConfig | null;
  /** Optional platform operations service for api_calls metering */
  operations?: any;
  /** Optional model selection service or circuit registry port for fallback and telemetry */
  modelRoutingPort?: ModelRoutingPort;
}

const IN_CONTAINER_PLACEHOLDER_VALUES = new Set([
  'in-container',
  'in-container-placeholder',
  'in_container_placeholder',
  'IN_CONTAINER_PLACEHOLDER',
  'Bearer in-container',
  'Bearer in-container-placeholder',
  'Bearer in_container_placeholder',
  'Bearer IN_CONTAINER_PLACEHOLDER',
]);

/**
 * Checks if a credential header value is an in-container placeholder.
 */
export function isPlaceholderCredential(val: string | undefined): boolean {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (IN_CONTAINER_PLACEHOLDER_VALUES.has(trimmed)) return true;
  if (trimmed.startsWith('Bearer ')) {
    const tokenPart = trimmed.slice(7).trim();
    return IN_CONTAINER_PLACEHOLDER_VALUES.has(tokenPart);
  }
  return false;
}

/**
 * Checks whether a given host or URL target is allowed under the whitelist.
 */
export function isAllowedHost(hostOrUrl: string, allowedOrigin = DEEPSEEK_BASE_ORIGIN): boolean {
  if (!hostOrUrl || typeof hostOrUrl !== 'string') {
    return false;
  }

  const trimmed = hostOrUrl.trim().toLowerCase();

  // Allowed local container tunnel targets when incoming from container
  if (
    trimmed === '127.0.0.1:8787' ||
    trimmed === 'localhost:8787' ||
    trimmed === '127.0.0.1' ||
    trimmed === 'localhost' ||
    trimmed === 'http://127.0.0.1:8787' ||
    trimmed.startsWith('http://127.0.0.1:8787/')
  ) {
    return true;
  }

  // Allowed upstream host
  try {
    const parsedAllowed = new URL(allowedOrigin);
    const allowedHostname = parsedAllowed.hostname.toLowerCase();

    if (trimmed === allowedHostname || trimmed === `${allowedHostname}:443` || trimmed === `${allowedHostname}:80`) {
      return true;
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      return parsed.hostname.toLowerCase() === allowedHostname;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Strips the `/llm` or `/llm/` prefix from a request URL pathname.
 */
export function normalizeLlmPath(pathname: string): string {
  if (!pathname || typeof pathname !== 'string') {
    return '/chat/completions';
  }
  if (pathname === '/llm') {
    return '/';
  }
  if (pathname.startsWith('/llm/')) {
    return pathname.slice(4); // Keep leading '/'
  }
  return pathname;
}

/**
 * Parses route prefix `/llm/<providerKey>/...` to extract providerKey and remainingPath.
 */
export function parseLlmProviderRoute(rawPath: string): {
  providerKey: string | null;
  remainingPath: string;
} {
  if (!rawPath || typeof rawPath !== 'string') {
    return { providerKey: null, remainingPath: '/' };
  }

  let pathname = rawPath;
  try {
    if (pathname.startsWith('http://') || pathname.startsWith('https://')) {
      const u = new URL(pathname);
      pathname = u.pathname + u.search;
    }
  } catch {}

  // Strip leading /llm or /llm/ if present
  let stripped = pathname;
  if (stripped.startsWith('/llm/')) {
    stripped = stripped.slice(5); // Remove '/llm/'
  } else if (stripped.startsWith('/llm')) {
    stripped = stripped.slice(4); // Remove '/llm'
  } else if (stripped.startsWith('/')) {
    stripped = stripped.slice(1);
  }

  const slashIdx = stripped.indexOf('/');
  const qIdx = stripped.indexOf('?');
  const endIdx =
    slashIdx !== -1 && qIdx !== -1
      ? Math.min(slashIdx, qIdx)
      : slashIdx !== -1
      ? slashIdx
      : qIdx !== -1
      ? qIdx
      : stripped.length;

  const providerKey = stripped.slice(0, endIdx).trim() || null;
  const remaining = endIdx < stripped.length ? stripped.slice(endIdx) : '/';
  const remainingPath =
    remaining.startsWith('/') || remaining.startsWith('?') ? remaining : `/${remaining}`;

  return {
    providerKey,
    remainingPath,
  };
}

/**
 * Resolves upstream URL given provider's baseURL and remainingPath.
 */
export function buildUpstreamUrl(baseURL: string, remainingPath: string): string {
  const base = baseURL.replace(/\/+$/, '');
  const pathPart = remainingPath.startsWith('/') ? remainingPath : `/${remainingPath}`;

  // If baseURL ends with /v1 and remainingPath starts with /v1/, avoid duplicate /v1
  if (base.endsWith('/v1') && pathPart.startsWith('/v1/')) {
    return `${base}${pathPart.slice(3)}`;
  }
  if (base.endsWith('/v1') && pathPart === '/v1') {
    return base;
  }

  return `${base}${pathPart}`;
}

/**
 * Parses raw HTTP/1.1 request wire bytes from a readable stream buffer.
 */
export interface ParsedHttpRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Reads a complete HTTP/1.1 request from a Duplex stream.
 */
export async function parseHttp1RequestFromStream(stream: Duplex): Promise<ParsedHttpRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEndIndex = -1;
    let expectedBodyLength = -1;
    let isChunked = false;
    let headersParsed = false;
    let method = 'POST';
    let url = '/chat/completions';
    let httpVersion = '1.1';
    const headers: Record<string, string> = {};

    function tryParseHeaders(): boolean {
      const allBuf = Buffer.concat(chunks);
      headerEndIndex = allBuf.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        headerEndIndex = allBuf.indexOf('\n\n');
      }
      if (headerEndIndex === -1) {
        return false;
      }

      const headerText = allBuf.subarray(0, headerEndIndex).toString('latin1');
      const lines = headerText.split(/\r?\n/);
      const reqLine = lines[0] || 'POST /chat/completions HTTP/1.1';
      const reqParts = reqLine.split(' ');
      method = (reqParts[0] || 'POST').toUpperCase();
      url = reqParts[1] || '/chat/completions';
      httpVersion = (reqParts[2] || 'HTTP/1.1').replace(/^HTTP\//i, '');

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          const val = line.slice(colon + 1).trim();
          headers[key] = val;
        }
      }

      if (headers['content-length']) {
        const cl = parseInt(headers['content-length'], 10);
        expectedBodyLength = Number.isSafeInteger(cl) && cl >= 0 ? cl : 0;
      } else if (headers['transfer-encoding']?.includes('chunked')) {
        isChunked = true;
      } else if (method === 'GET' || method === 'HEAD') {
        expectedBodyLength = 0;
      }

      headersParsed = true;
      return true;
    }

    function checkCompletion(): void {
      if (!headersParsed) {
        if (!tryParseHeaders()) {
          return;
        }
      }

      const allBuf = Buffer.concat(chunks);
      const headerEnd =
        allBuf.indexOf('\r\n\r\n') !== -1
          ? allBuf.indexOf('\r\n\r\n') + 4
          : allBuf.indexOf('\n\n') + 2;

      const bodyBuf = allBuf.subarray(headerEnd);

      if (expectedBodyLength >= 0) {
        if (bodyBuf.length >= expectedBodyLength) {
          cleanup();
          resolve({
            method,
            url,
            httpVersion,
            headers,
            body: bodyBuf.subarray(0, expectedBodyLength),
          });
        }
      } else if (isChunked) {
        if (bodyBuf.includes(Buffer.from('0\r\n\r\n'))) {
          cleanup();
          resolve({
            method,
            url,
            httpVersion,
            headers,
            body: bodyBuf,
          });
        }
      }
    }

    function onData(chunk: Buffer | string): void {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      checkCompletion();
    }

    function onEnd(): void {
      if (!headersParsed) {
        tryParseHeaders();
      }
      const allBuf = Buffer.concat(chunks);
      let bodyBuf = Buffer.alloc(0);
      if (headerEndIndex >= 0) {
        const headerEnd =
          allBuf.indexOf('\r\n\r\n') !== -1
            ? allBuf.indexOf('\r\n\r\n') + 4
            : allBuf.indexOf('\n\n') + 2;
        bodyBuf = allBuf.subarray(headerEnd);
      }
      cleanup();
      resolve({
        method,
        url,
        httpVersion,
        headers,
        body: bodyBuf,
      });
    }

    function onError(err: Error): void {
      cleanup();
      reject(err);
    }

    function cleanup(): void {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);

    if (stream.readableEnded) {
      onEnd();
    }
  });
}

/**
 * LlmProxyHandler implements StreamHandler for kind: 'llm'.
 */
export class LlmProxyHandler implements StreamHandler {
  readonly kind = LLM_STREAM_KIND;
  private readonly fetchFn: typeof fetch;
  private readonly explicitDeploymentConfig?: DshDeploymentConfig | null;
  private readonly operations?: any;
  private readonly modelRoutingPort?: ModelRoutingPort;
  private customProviders?: Record<string, DshParsedProvider>;
  private customTokens?: Record<string, string>;
  private customAllowedHosts?: string[];

  constructor(options: LlmProxyOptions = {}) {
    this.fetchFn = options.fetchImpl ?? globalThis.fetch;
    this.explicitDeploymentConfig = options.deploymentConfig;
    this.operations = options.operations;
    this.modelRoutingPort = options.modelRoutingPort;
    if (options.deploymentConfig) {
      this.customProviders = options.deploymentConfig.providers;
      this.customTokens = options.deploymentConfig.tokens;
      this.customAllowedHosts = options.deploymentConfig.allowedHosts;
    } else {
      if (options.providers) this.customProviders = options.providers;
      if (options.tokens) this.customTokens = options.tokens;
      if (options.allowedHosts) this.customAllowedHosts = options.allowedHosts;
    }
  }

  /**
   * Retrieves active in-memory deployment configuration.
   */
  private getActiveConfig(): DshDeploymentConfig | null {
    if (this.explicitDeploymentConfig !== undefined) {
      return this.explicitDeploymentConfig;
    }
    if (this.customProviders && this.customTokens) {
      return {
        dshHome: path.join(os.homedir(), '.dsh'),
        providers: this.customProviders,
        tokens: this.customTokens,
        defaultModel: {
          provider: Object.keys(this.customProviders)[0] || 'cpa-claude',
          model: 'claude-fable-5',
        },
        allowedHosts:
          this.customAllowedHosts ??
          Object.values(this.customProviders)
            .map((p) => {
              try {
                return new URL(p.baseURL).hostname.toLowerCase();
              } catch {
                return '';
              }
            })
            .filter(Boolean),
      };
    }
    return loadDshDeploymentConfig();
  }

  /**
   * Handles an incoming duplex stream from the tunnel.
   */
  async handle(stream: Duplex, metadata: StreamMetadata): Promise<void> {
    if (metadata.kind !== LLM_STREAM_KIND) {
      this.writeErrorResponse(stream, 400, 'Invalid stream kind', 'invalid_stream_kind');
      return;
    }

    const userId = typeof metadata.userId === 'string' && metadata.userId.length > 0
      ? metadata.userId
      : undefined;

    try {
      const parsedReq = await parseHttp1RequestFromStream(stream);
      await this.handleParsedRequest(parsedReq, stream, userId);
    } catch (_err: unknown) {
      this.writeErrorResponse(
        stream,
        500,
        'Internal proxy error processing stream request',
        'proxy_stream_error'
      );
    }
  }

  /**
   * Processes a parsed HTTP request and writes the upstream response back to the duplex stream.
   */
  private async handleParsedRequest(req: ParsedHttpRequest, stream: Duplex, userId?: string): Promise<void> {
    const config = this.getActiveConfig();

    // 1. Check for missing deployment configuration
    if (!config || !config.providers || Object.keys(config.providers).length === 0) {
      this.writeErrorResponse(
        stream,
        503,
        'DSH LLM deployment configuration is missing or empty on platform host',
        'missing_llm_config'
      );
      return;
    }

    // 2. Parse providerKey from request path
    const { providerKey, remainingPath } = parseLlmProviderRoute(req.url);
    if (!providerKey || !config.providers[providerKey]) {
      const fallbackKey = Object.keys(config.providers)[0];
      if (!providerKey && fallbackKey && config.providers[fallbackKey]) {
        await this.forwardToProvider(
          fallbackKey,
          config.providers[fallbackKey]!,
          remainingPath,
          req,
          stream,
          config,
          userId
        );
        return;
      }

      this.writeErrorResponse(
        stream,
        404,
        `Unknown LLM provider key "${providerKey || 'empty'}" in request URL`,
        'unknown_provider'
      );
      return;
    }

    const provider = config.providers[providerKey]!;
    await this.forwardToProvider(providerKey, provider, remainingPath, req, stream, config, userId);
  }

  /**
   * Forwards a request to the resolved provider with fallback chain and circuit breaker support.
   */
  private async forwardToProvider(
    providerKey: string,
    provider: DshParsedProvider,
    remainingPath: string,
    req: ParsedHttpRequest,
    stream: Duplex,
    config: DshDeploymentConfig,
    userId?: string
  ): Promise<void> {
    // Parse JSON body to extract requested model
    let primaryModelId = '';
    let jsonBody: Record<string, unknown> | null = null;
    if (req.body && req.body.length > 0) {
      try {
        jsonBody = JSON.parse(req.body.toString('utf8'));
        if (jsonBody && typeof jsonBody.model === 'string') {
          primaryModelId = jsonBody.model;
        }
      } catch (_jsonErr: unknown) {
        jsonBody = null;
      }
    }

    // Resolve fallback chain from request headers or modelRoutingPort
    let fallbackTargets: FallbackTarget[] = [];
    const rawChainHeader = req.headers['x-enkeep-fallback-chain'];
    if (typeof rawChainHeader === 'string' && rawChainHeader.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawChainHeader);
        if (Array.isArray(parsed)) {
          fallbackTargets = parsed.map((item) => ({
            provider: String(item.provider || '').trim(),
            model: String(item.model || '').trim(),
            reasoningEffort: item.reasoningEffort ? String(item.reasoningEffort).trim() : null,
          })).filter((item) => item.provider.length > 0 && item.model.length > 0);
        }
      } catch (_chainErr: unknown) {
        fallbackTargets = [];
      }
    }

    if (fallbackTargets.length === 0 && this.modelRoutingPort?.getEffectiveFallbackChain && userId) {
      try {
        const chain = await this.modelRoutingPort.getEffectiveFallbackChain(userId);
        if (Array.isArray(chain)) {
          fallbackTargets = chain;
        }
      } catch (_chainFetchErr: unknown) {
        fallbackTargets = [];
      }
    }

    const candidates: FallbackTarget[] = [
      { provider: providerKey, model: primaryModelId || 'default' },
      ...fallbackTargets,
    ];

    // Meter api_calls quota if operations is present
    let reservationId: string | null = null;
    let tenantQuota: any = null;
    if (this.operations && userId && typeof this.operations.forTenant === 'function') {
      try {
        tenantQuota = this.operations.forTenant(userId).quota;
        if (tenantQuota) {
          let hasLimit = false;
          if (typeof tenantQuota.getLimit === 'function') {
            const lim = await tenantQuota.getLimit('api_calls');
            if (lim && typeof lim.limit === 'number' && lim.limit > 0) {
              hasLimit = true;
            }
          }
          if (hasLimit && typeof tenantQuota.reserveQuota === 'function') {
            const resv = await tenantQuota.reserveQuota({ resource: 'api_calls', amount: 1, ttlSeconds: 60 });
            reservationId = resv?.id ?? null;
          }
        }
      } catch (qErr: any) {
        if (qErr?.code === 'QUOTA_EXCEEDED' || qErr?.name === 'QuotaExceededError') {
          this.writeErrorResponse(stream, 429, 'Quota exceeded for api_calls', 'quota_exceeded');
          return;
        }
      }
    }

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    stream.on('close', onClose);

    let lastErrorStatus = 502;
    let lastErrorMessage = 'Failed to reach upstream LLM gateway';
    let lastErrorCode = 'upstream_error';

    try {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const isPrimary = i === 0;

        // 1. Check circuit breaker if modelRoutingPort is configured
        if (this.modelRoutingPort) {
          const breaker = this.modelRoutingPort.canExecute(candidate.provider, candidate.model);
          if (!breaker.allowed) {
            continue; // Circuit open, skip to next candidate
          }
        }

        const candProvider = config.providers[candidate.provider];
        if (!candProvider) {
          continue;
        }

        // 2. Upstream URL & whitelist check
        const targetUrlStr = buildUpstreamUrl(candProvider.baseURL, remainingPath);
        let targetUrl: URL;
        try {
          targetUrl = new URL(targetUrlStr);
        } catch {
          continue;
        }

        const targetHostname = targetUrl.hostname.toLowerCase();
        const isWhitelisted = (config.allowedHosts || []).some(
          (h) => h.toLowerCase() === targetHostname || targetHostname.endsWith(`.${h.toLowerCase()}`)
        );
        if (!isWhitelisted) {
          if (isPrimary && fallbackTargets.length === 0) {
            this.writeErrorResponse(
              stream,
              403,
              `Host "${targetHostname}" is forbidden; not present in DSH deployment configuration`,
              'forbidden_host'
            );
            return;
          }
          continue;
        }

        const tokenKeyName = candProvider.apiKeyEnv || 'CPA_TOKEN';
        const realToken = config.tokens[tokenKeyName] || process.env[tokenKeyName];
        if (!realToken || realToken.trim().length === 0) {
          if (isPrimary && fallbackTargets.length === 0) {
            this.writeErrorResponse(
              stream,
              503,
              `API token "${tokenKeyName}" is not configured on platform host`,
              'missing_api_token'
            );
            return;
          }
          continue;
        }

        // 3. Prepare headers
        const upstreamHeaders = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          const lk = key.toLowerCase();
          if (
            lk === 'host' ||
            lk === 'connection' ||
            lk === 'keep-alive' ||
            lk === 'proxy-authenticate' ||
            lk === 'proxy-authorization' ||
            lk === 'te' ||
            lk === 'trailer' ||
            lk === 'transfer-encoding' ||
            lk === 'upgrade' ||
            lk.startsWith('x-enkeep-')
          ) {
            continue;
          }
          if (lk === 'authorization') {
            upstreamHeaders.set('authorization', `Bearer ${realToken.trim()}`);
          } else if (lk === 'x-api-key') {
            upstreamHeaders.set('x-api-key', realToken.trim());
          } else {
            upstreamHeaders.set(key, value);
          }
        }

        if (candProvider.api === 'anthropic-messages') {
          upstreamHeaders.set('x-api-key', realToken.trim());
        } else {
          upstreamHeaders.set('authorization', `Bearer ${realToken.trim()}`);
        }
        upstreamHeaders.set('host', targetUrl.host);

        // 4. Prepare request body
        let reqBody = req.body;
        if (jsonBody && candidate.model) {
          const updatedJson = { ...jsonBody, model: candidate.model };
          reqBody = Buffer.from(JSON.stringify(updatedJson), 'utf8');
          upstreamHeaders.set('content-length', String(reqBody.length));
        }

        let bytesWrittenToStream = false;
        const startTime = Date.now();
        try {
          const fetchOptions: RequestInit = {
            method: req.method,
            headers: upstreamHeaders,
            signal: abortController.signal,
          };
          if (req.method !== 'GET' && req.method !== 'HEAD' && reqBody && reqBody.length > 0) {
            fetchOptions.body = reqBody as any;
          }

          const upstreamResponse = await this.fetchFn(targetUrlStr, fetchOptions);
          const latencyMs = Math.max(1, Date.now() - startTime);

          if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
            // Success
            if (this.modelRoutingPort) {
              try {
                await this.modelRoutingPort.recordHealth({
                  provider: candidate.provider,
                  model: candidate.model,
                  latencyMs,
                  statusCode: upstreamResponse.status,
                  success: true,
                });
              } catch {}
            }

            if (tenantQuota && reservationId) {
              try {
                await tenantQuota.commitQuota({ reservationId, actualAmount: 1 });
              } catch {}
            }

            const statusLine = `HTTP/1.1 ${upstreamResponse.status} ${upstreamResponse.statusText || 'OK'}\r\n`;
            stream.write(statusLine);

            upstreamResponse.headers.forEach((val, key) => {
              const lk = key.toLowerCase();
              if (lk !== 'connection' && lk !== 'keep-alive' && lk !== 'transfer-encoding') {
                stream.write(`${key}: ${val}\r\n`);
              }
            });
            stream.write(`x-enkeep-model-provider: ${candidate.provider}\r\n`);
            stream.write(`x-enkeep-model-id: ${candidate.model}\r\n`);
            stream.write(`x-enkeep-fallback-used: ${isPrimary ? 'false' : 'true'}\r\n`);
            stream.write('\r\n');
            bytesWrittenToStream = true;

            if (upstreamResponse.body) {
              try {
                for await (const chunk of upstreamResponse.body as any) {
                  if (stream.writableEnded || stream.destroyed) break;
                  const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
                  stream.write(buf);
                }
              } catch (streamBodyErr: unknown) {
                // Mid-stream failure: bytes already sent to container. NEVER fallback to another model to splice streams!
                if (this.modelRoutingPort) {
                  try {
                    await this.modelRoutingPort.recordHealth({
                      provider: candidate.provider,
                      model: candidate.model,
                      latencyMs: Math.max(1, Date.now() - startTime),
                      statusCode: 500,
                      success: false,
                      errorType: 'STREAM_MID_FAILURE',
                    });
                  } catch {}
                }
                if (!stream.destroyed) {
                  stream.destroy(streamBodyErr instanceof Error ? streamBodyErr : new Error(String(streamBodyErr)));
                }
                return;
              }
            }
            stream.end();
            return;
          }

          // 4xx Permanent/Auth failures -> Fail fast without fallback!
          if (
            upstreamResponse.status === 400 ||
            upstreamResponse.status === 401 ||
            upstreamResponse.status === 403 ||
            upstreamResponse.status === 404 ||
            upstreamResponse.status === 422
          ) {
            if (this.modelRoutingPort) {
              try {
                await this.modelRoutingPort.recordHealth({
                  provider: candidate.provider,
                  model: candidate.model,
                  latencyMs,
                  statusCode: upstreamResponse.status,
                  success: false,
                  errorType: 'AUTH_FAILURE',
                });
              } catch {}
            }

            if (tenantQuota && reservationId) {
              try {
                await tenantQuota.releaseQuota({ reservationId });
              } catch {}
            }

            const statusLine = `HTTP/1.1 ${upstreamResponse.status} ${upstreamResponse.statusText || 'Error'}\r\n`;
            stream.write(statusLine);
            upstreamResponse.headers.forEach((val, key) => {
              const lk = key.toLowerCase();
              if (lk !== 'connection' && lk !== 'keep-alive' && lk !== 'transfer-encoding') {
                stream.write(`${key}: ${val}\r\n`);
              }
            });
            stream.write('\r\n');
            bytesWrittenToStream = true;
            if (upstreamResponse.body) {
              for await (const chunk of upstreamResponse.body as any) {
                if (stream.writableEnded || stream.destroyed) break;
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
                stream.write(buf);
              }
            }
            stream.end();
            return;
          }

          // 5xx / 429 Transient failures -> record health and try next candidate in chain (if no bytes sent)!
          if (this.modelRoutingPort) {
            try {
              await this.modelRoutingPort.recordHealth({
                provider: candidate.provider,
                model: candidate.model,
                latencyMs,
                statusCode: upstreamResponse.status,
                success: false,
                errorType: 'SERVER_ERROR',
              });
            } catch {}
          }
          lastErrorStatus = upstreamResponse.status;
          lastErrorMessage = `Upstream returned status ${upstreamResponse.status}`;
          lastErrorCode = 'upstream_transient_error';
        } catch (fetchErr: unknown) {
          if (bytesWrittenToStream) {
            // If bytes were already written to stream, do NOT fallback
            if (!stream.destroyed) {
              stream.destroy(fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr)));
            }
            return;
          }
          const latencyMs = Math.max(1, Date.now() - startTime);
          if (this.modelRoutingPort) {
            try {
              await this.modelRoutingPort.recordHealth({
                provider: candidate.provider,
                model: candidate.model,
                latencyMs,
                statusCode: 503,
                success: false,
                errorType: 'TRANSIENT_NETWORK',
              });
            } catch {}
          }
          lastErrorStatus = 502;
          lastErrorMessage = 'Upstream gateway request failed';
          lastErrorCode = 'upstream_fetch_error';
        }
      }

      if (tenantQuota && reservationId) {
        try {
          await tenantQuota.releaseQuota({ reservationId });
        } catch {}
      }

      if (!stream.writableEnded && !stream.destroyed) {
        this.writeErrorResponse(stream, lastErrorStatus, lastErrorMessage, lastErrorCode);
      }
    } finally {
      stream.removeListener('close', onClose);
    }
  }

  /**
   * Helper to write an immediate standard JSON error response over a Duplex stream.
   */
  private writeErrorResponse(
    stream: Duplex,
    statusCode: number,
    message: string,
    errorCode: string
  ): void {
    if (stream.writableEnded || stream.destroyed) {
      return;
    }
    const statusText =
      statusCode === 503
        ? 'Service Unavailable'
        : statusCode === 403
        ? 'Forbidden'
        : statusCode === 404
        ? 'Not Found'
        : statusCode === 400
        ? 'Bad Request'
        : statusCode === 502
        ? 'Bad Gateway'
        : 'Internal Server Error';

    const payload = JSON.stringify({
      error: {
        message,
        type:
          statusCode === 503
            ? 'service_unavailable'
            : statusCode === 403
            ? 'permission_denied'
            : 'invalid_request_error',
        code: errorCode,
      },
    });

    const headers = [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`,
      'Connection: close',
      '\r\n',
    ].join('\r\n');

    stream.write(headers + payload);
    stream.end();
  }

  /**
   * Directly handles a standard Node.js HTTP request/response if invoked at the HTTP layer,
   * routing through the unified fallback chain, circuit breaker, and health tracking engine.
   */
  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) {
      bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(bodyChunks);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
    }

    const parsedReq: ParsedHttpRequest = {
      method: req.method || 'POST',
      url: req.url || '/',
      httpVersion: req.httpVersion || '1.1',
      headers,
      body,
    };

    const duplex = new PassThrough();

    let headersParsed = false;
    let headerBuffer = Buffer.alloc(0);

    duplex.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (headersParsed) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(buf);
        }
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, buf]);
      const headerEndIdx = headerBuffer.indexOf('\r\n\r\n');
      if (headerEndIdx !== -1) {
        headersParsed = true;
        const headerText = headerBuffer.slice(0, headerEndIdx).toString('utf8');
        const bodyRemainder = headerBuffer.slice(headerEndIdx + 4);

        const lines = headerText.split('\r\n');
        const statusLine = lines[0] || 'HTTP/1.1 200 OK';
        const parts = statusLine.split(' ');
        const statusCode = parseInt(parts[1] || '200', 10);

        const resHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':');
          if (colonIdx > 0) {
            const key = lines[i].slice(0, colonIdx).trim();
            const val = lines[i].slice(colonIdx + 1).trim();
            resHeaders[key] = val;
          }
        }

        if (!res.headersSent) {
          res.writeHead(statusCode, resHeaders);
        }
        if (bodyRemainder.length > 0 && !res.writableEnded && !res.destroyed) {
          res.write(bodyRemainder);
        }
      }
    });

    duplex.on('end', () => {
      if (!headersParsed && headerBuffer.length > 0 && !res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(headerBuffer);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    });

    duplex.on('error', (err: Error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'bad_gateway', message: 'Upstream gateway error' } }));
      } else if (!res.destroyed) {
        res.destroy(err);
      }
    });

    await this.handleParsedRequest(parsedReq, duplex);
  }
}

/**
 * Factory function creating an LlmProxyHandler instance.
 */
export function createLlmProxyHandler(options?: LlmProxyOptions): LlmProxyHandler {
  return new LlmProxyHandler(options);
}
