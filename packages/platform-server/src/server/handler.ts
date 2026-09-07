/**
 * Authoritative Canonical HTTP Request Handler for Enkeep Platform Server
 *
 * Implements strict, unified, secure routing for:
 * - Direct pathname routing (NO fuzzy normalizePath / /api/v1 stripping)
 * - Safe error mapping to fixed public message allowlist (no sanitizeErrorMessage/regex leaks)
 * - Strict exact raw input validation (no trimming or coercion before validation)
 * - Exact canonical query parameter parsing (decimal regex + String(Number(x)) === x)
 * - Space/session/profile/task names raw === trim
 * - Idempotency-Key exact canonical lowercase UUID v4 (no trim)
 * - Authoritative ConsoleDataSource, AgentProfileApi, OperationsApi, RuntimeGateway, Filesystem integration
 *
 * @module @enkeep/platform-server/server/handler
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  UnauthorizedError,
  ConflictError,
  type User,
  type PlatformStorage,
  type AuthService,
  type BrowserService,
  type PlatformProxyMcpService,
} from "@enkeep/platform-core";
import { canManageHostRuntime } from "@enkeep/platform-auth";
import {
  createSuccessEnvelope,
  createErrorEnvelope,
} from "@enkeep/protocol";
import {
  type PublicSpace,
  type PublicSession,
  type PublicMessage,
  type PublicWebChannelEvent,
  type InboundEnvelope,
  type PublicProfileBinding,
  type PlatformWebApi,
  type RuntimeGateway,
} from "@enkeep/web-channel";
import type { DefaultAuthService } from "@enkeep/platform-auth";
import type { SqlitePlatformStorage } from "@enkeep/platform-storage-sqlite";
import { getWebUiAsset, getWebUiIndexHtml } from "@enkeep/web-ui";
import {
  validateHost,
  validateCsrf,
  validatePathId,
  validateMessageContent,
  validateAttachments,
  FailedLoginRateLimiter,
  PayloadTooLargeError,
  CsrfViolationError,
  API_CACHE_CONTROL_HEADERS,
  DEFAULT_SERVER_LIMITS,
  type ServerLimitsOptions,
} from "../safety/limits.js";
import {
  validateUserRuntimeStatus,
  validateOperationsReadinessStatus,
} from "../management/status-validators.js";
import { ConsoleDataSource } from "../management/console-data-source.js";
import type { TenantQuotaDefaultsConfig } from "../management/tenant-provisioning-service.js";
import type {
  ManagementRuntimeProvider,
  ManagementOperationsProvider,
  AdminDashboardContainerKpi,
  UserRuntimeStatus,
  OperationsReadinessStatus,
} from "../management/types.js";
import type { PlatformOperationsService, AgentPromptTaskWorker, QuotaMetric, TaskPriority } from "@enkeep/platform-operations";
import { QuotaExceededError } from "@enkeep/platform-operations";
import Busboy from "busboy";
import {
  RuntimeFileApiService,
  validateRelativeFilePath,
  type CanonicalFileOperationRequest,
  type CanonicalWriteRequest,
  type CanonicalWriteResult,
  type TenantRuntimeFileProvider,
} from "../files/runtime-file-api.js";
import {
  sniffMimeType,
  buildContentDispositionHeader,
  sanitizeMultipartFilename,
  parseRangeHeader,
  ByteLimitTransform,
  computeUploadRequestHash,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_UPLOAD_FILES_COUNT,
} from "../files/file-transport-utils.js";
import type { AgentProfileApi, SafeAgentProfileItem, PublicAgentProfileSnapshot } from "../profiles/profile-service.js";
import type { HappyClawMigrationRoutes } from "../imports/happyclaw-migration-routes.js";
import type { ExtensionRoutes } from "../extensions/extension-routes.js";
import type { InstructionsRoutes } from "../instructions/index.js";
import type { ChannelRoutes } from "../channels/channel-routes.js";
import { SpaceMountService } from "../mounts/space-mount-service.js";
import type { IExternalInteractionService, ApprovalOutcome } from "@enkeep/dsh-external-interaction";
import { DualStorageReconcileService } from "../storage/dual-storage-reconcile.js";
import { VolumeScanService } from "../storage/volume-scan.js";
import { createManagementOperationsAdapter } from "../operations/management-adapter.js";
import { RuntimeDiagnosticsService } from "../diagnostics/runtime-diagnostics-service.js";
import { AuditExportService } from "../exports/audit-export-service.js";
import { UsageExportService } from "../exports/usage-export-service.js";
import { TaskNotificationService } from "../notifications/task-notification-service.js";
import { WebhookSecurityError } from "../notifications/webhook-security-policy.js";
import { ModelSelectionService } from "../models/model-selection-service.js";
import { SessionLifecycleService } from "../sessions/session-lifecycle-service.js";
import type { RuntimeArtifactPort } from "../sessions/runtime-artifact-port.js";
import { generate32HexId } from "../storage/web-messages.js";

export type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getUnknownKeys(obj: Record<string, unknown>, allowedKeys: readonly string[] | Set<string>): string[] {
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

const CANONICAL_UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_POSITIVE_INT_REGEX = /^[1-9]\d*$/;
const CANONICAL_NON_NEGATIVE_INT_REGEX = /^(?:0|[1-9]\d*)$/;

const ALLOWED_LOGIN_KEYS = new Set(["username", "password"]);
const ALLOWED_ACCOUNT_PREFERENCES_KEYS = new Set(["locale", "theme"]);
const ALLOWED_ACCOUNT_THEME_KEYS = new Set(["theme"]);
const ALLOWED_CREATE_SPACE_KEYS = new Set(["name", "folder", "executionMode"]);
const ALLOWED_UPDATE_SPACE_KEYS = new Set(["name", "executionMode"]);
const ALLOWED_CREATE_SESSION_KEYS = new Set(["spaceId", "title", "executionMode", "peerId"]);
const ALLOWED_UPDATE_SESSION_KEYS = new Set(["title"]);
const ALLOWED_RESET_SESSION_KEYS = new Set(["reason"]);
const ALLOWED_FORK_SESSION_KEYS = new Set(["fromMessageId", "fromTurnId", "title", "targetSpaceId"]);
const ALLOWED_REGENERATE_SESSION_KEYS = new Set(["sourceMessageId", "title", "targetSpaceId"]);
const ALLOWED_MODEL_OVERRIDE_KEYS = new Set([
  "provider",
  "model",
  "reasoningEffort",
  "fallbackChain",
  "ifMatch",
]);
const ALLOWED_MODEL_PROBE_KEYS = new Set([
  "provider",
  "model",
  "mode",
]);
const ALLOWED_CIRCUIT_BREAKER_RESET_KEYS = new Set([
  "provider",
  "model",
]);
const ALLOWED_EDIT_MESSAGE_KEYS = new Set(["content", "attachments", "title", "targetSpaceId", "replyToMessageId"]);
const ALLOWED_MESSAGE_KEYS = new Set(["content", "attachments", "metadata", "replyToMessageId"]);
const ALLOWED_CREATE_TASK_KEYS = new Set([
  "title",
  "prompt",
  "sessionId",
  "dueDate",
  "priority",
  "scheduleType",
  "cronExpression",
  "intervalSeconds",
  "timezone",
  "misfirePolicy",
  "overlapPolicy",
]);
const ALLOWED_PROFILE_KEYS = new Set([
  "name",
  "description",
  "identity",
  "soul",
  "agents",
  "tools",
  "changeSummary",
]);
const ALLOWED_PROFILE_VERSION_KEYS = new Set([
  "description",
  "identity",
  "soul",
  "agents",
  "tools",
  "changeSummary",
]);
const ALLOWED_SPACE_BIND_KEYS = new Set(["profileId", "version"]);
const ALLOWED_SPACE_MOUNT_CREATE_KEYS = new Set(["name", "sourcePath", "mode"]);
const ALLOWED_FILE_WRITE_KEYS = new Set(["path", "content", "expectedEtag", "requireAbsent"]);
const ALLOWED_FILE_MKDIR_KEYS = new Set(["path", "requireAbsent"]);
const ALLOWED_FILE_DELETE_KEYS = new Set(["path", "expectedEtag"]);

const ALLOWED_CREATE_SUBSCRIPTION_KEYS = new Set(["channel", "destination", "secret", "events", "enabled"]);
const ALLOWED_UPDATE_SUBSCRIPTION_KEYS = new Set(["destination", "secret", "events", "enabled"]);
const ALLOWED_TEST_WEBHOOK_KEYS = new Set(["url", "secret"]);
const VALID_NOTIFICATION_CHANNELS = new Set(["in_app", "webhook"]);
const VALID_NOTIFICATION_EVENTS = new Set(["completed", "failed", "cancelled", "timeout", "started"]);

const VALID_TASK_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const VALID_TASK_STATUSES = new Set(["pending", "claimed", "running", "completed", "failed", "cancelled"]);
const VALID_DELIVERY_STATUSES = new Set(["held", "processing", "delivered", "duplicate", "cancelled", "failed"]);
const VALID_SPACE_STATUSES = new Set(["active", "archived"]);
const VALID_USER_ROLES = new Set(["admin", "user"]);
const VALID_USER_STATUSES = new Set(["active", "disabled"]);
const VALID_QUOTA_METRICS = new Set(["tokens", "messages", "turns", "storage_bytes", "api_calls"]);
const VALID_AUDIT_ACTIONS = new Set([
  "login_success",
  "login_failure",
  "logout",
  "session_revoked",
  "user_created",
  "user_updated",
  "user_disabled",
  "password_reset",
  "password_changed",
  "model_config_updated",
  "space_created",
  "space_updated",
  "space_archived",
  "space_restored",
  "session_restored",
  "session_forked",
  "task_created",
  "task_cancelled",
  "quota_updated",
  "quota_reset",
  "storage_adjusted",
  "storage_reconciled",
  "storage_repaired",
  "profile_created",
  "profile_updated",
  "profile_archived",
  "locale_changed",
  "audit_exported",
  "usage_exported",
]);

const FORBIDDEN_NAME_CHARS_REGEX = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/;

export interface PlatformServerHandlerOptions {
  database?: DatabaseSync;
  storage?: SqlitePlatformStorage | PlatformStorage;
  authService?: AuthService | DefaultAuthService;
  runtimeGateway: RuntimeGateway;
  platformApi: PlatformWebApi;
  csrfToken: string;
  cookieSecret?: string;
  limits?: ServerLimitsOptions;
  rateLimiter?: FailedLoginRateLimiter;
  customWebUiHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | void;
  managementProvider?: ManagementRuntimeProvider;
  consoleDataSource?: ConsoleDataSource;
  quotaDefaults?: TenantQuotaDefaultsConfig;
  operations?: PlatformOperationsService;
  operationsProvider?: ManagementOperationsProvider;
  taskWorker?: AgentPromptTaskWorker;
  fileProvider?: TenantRuntimeFileProvider;
  fileService?: RuntimeFileApiService;
  agentProfileApi?: AgentProfileApi;
  happyClawMigrationRoutes?: HappyClawMigrationRoutes;
  extensionRoutes?: ExtensionRoutes;
  instructionsRoutes?: InstructionsRoutes;
  channelRoutes?: ChannelRoutes;
  runtimeDiagnosticsService?: RuntimeDiagnosticsService;
  auditExportService?: AuditExportService;
  usageExportService?: UsageExportService;
  taskNotificationService?: TaskNotificationService;
  modelSelectionService?: ModelSelectionService;
  externalInteractionService?: IExternalInteractionService;
  sessionLifecycleService?: SessionLifecycleService;
  runtimeArtifactPort?: RuntimeArtifactPort;
  spaceMountService?: SpaceMountService;
  browserService?: BrowserService;
  mcpService?: PlatformProxyMcpService;
}

function isValidIsoDate(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const d = new Date(raw);
  return !isNaN(d.getTime()) && d.toISOString() === raw;
}

function validateExactTrimmed(val: unknown, fieldName: string): string {
  if (typeof val !== "string") {
    throw new ValidationError(`Field "${fieldName}" must be a string`);
  }
  if (val !== val.trim()) {
    throw new ValidationError(`Field "${fieldName}" must not contain leading or trailing whitespace`);
  }
  return val;
}

function validateResourceName(val: unknown, fieldName: string): string {
  const str = validateExactTrimmed(val, fieldName);
  if (str.length === 0) {
    throw new ValidationError(`Field "${fieldName}" must not be empty`);
  }
  if (str.length > 128) {
    throw new ValidationError(`Field "${fieldName}" must not exceed 128 characters`);
  }
  if (FORBIDDEN_NAME_CHARS_REGEX.test(str)) {
    throw new ValidationError(`Field "${fieldName}" contains forbidden control characters`);
  }
  if (str.normalize("NFC") !== str) {
    throw new ValidationError(`Field "${fieldName}" must be normalized NFC Unicode`);
  }
  return str;
}

function parseLimit(raw: string): number {
  if (typeof raw !== "string" || !CANONICAL_POSITIVE_INT_REGEX.test(raw) || String(Number(raw)) !== raw) {
    throw new ValidationError('Invalid limit query parameter: must be a positive canonical decimal integer');
  }
  const val = Number(raw);
  if (val < 1 || val > 100) {
    throw new ValidationError('Invalid limit query parameter: must be between 1 and 100');
  }
  return val;
}

function parseOffset(raw: string): number {
  if (typeof raw !== "string" || !CANONICAL_NON_NEGATIVE_INT_REGEX.test(raw) || String(Number(raw)) !== raw) {
    throw new ValidationError('Invalid offset query parameter: must be a non-negative canonical decimal integer');
  }
  return Number(raw);
}

function sendJsonResponse(res: ServerResponse, statusCode: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const json = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [k, v] of Object.entries(API_CACHE_CONTROL_HEADERS)) {
    res.setHeader(k, v);
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  res.end(json);
}

function sendEmptySuccess(res: ServerResponse, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [k, v] of Object.entries(API_CACHE_CONTROL_HEADERS)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(createSuccessEnvelope({})));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        rejected = true;
        req.pause();
        reject(new PayloadTooLargeError("Request payload exceeds maximum allowed size"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      if (rejected) return;
      reject(err);
    });
  });
}

async function parseJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await readBody(req, maxBytes);
  if (!text || text.trim().length === 0) {
    throw new ValidationError("Request body cannot be empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("Malformed JSON request body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader || typeof cookieHeader !== "string") return map;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const name = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      map.set(name, decodeURIComponent(val));
    }
  }
  return map;
}

function requireIdempotencyKey(req: IncomingMessage): string {
  if (req.headers["x-idempotency-key"] !== undefined) {
    throw new ValidationError('Alternate header "x-idempotency-key" is not permitted. Use canonical "Idempotency-Key" header');
  }
  const raw = req.headers["idempotency-key"];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.length === 0)) {
    throw new ValidationError("Missing required Idempotency-Key header. Canonical Idempotency-Key header is required. Format: canonical lowercase UUID-v4.");
  }
  if (Array.isArray(raw) || raw.includes(",")) {
    throw new ValidationError("Duplicate or comma-separated Idempotency-Key headers (arrays and comma-separated) are forbidden");
  }
  if (typeof raw !== "string" || raw !== raw.trim() || !CANONICAL_UUID_V4_REGEX.test(raw)) {
    throw new ValidationError("Invalid Idempotency-Key format. Expected exact canonical lowercase UUID v4 (canonical lowercase UUID-v4).");
  }
  return raw;
}

function mapErrorToResponse(err: unknown): { status: number; envelope: unknown } {
  if (
    err instanceof PlatformError ||
    (typeof err === "object" &&
      err !== null &&
      typeof (err as any).status === "number" &&
      typeof (err as any).code === "string")
  ) {
    const platErr = err as PlatformError;
    return {
      status: platErr.status,
      envelope: createErrorEnvelope({
        code: platErr.code,
        message: platErr.message,
        status: platErr.status,
      }),
    };
  }

  const code = (err as any)?.code || "INTERNAL_ERROR";
  const status = typeof (err as any)?.status === "number" && (err as any).status >= 400 && (err as any).status <= 599
    ? (err as any).status
    : 500;

  if (status >= 500) {
    if (process.env.DEBUG_SERVER_ERRORS) {
      console.error("MAP_ERROR_500:", err);
    }
    return {
      status,
      envelope: createErrorEnvelope({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        status,
      }),
    };
  }

  return {
    status,
    envelope: createErrorEnvelope({
      code: typeof code === "string" ? code : "BAD_REQUEST",
      message: (err as any)?.message || "An unexpected error occurred",
      status,
    }),
  };
}

function isQuotaExceededError(err: unknown): boolean {
  if (err instanceof QuotaExceededError) return true;
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "QUOTA_EXCEEDED") {
    return true;
  }
  return false;
}

export function createPlatformServerHandler(options: PlatformServerHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    database: db,
    storage,
    authService,
    runtimeGateway,
    platformApi,
    csrfToken,
    limits = DEFAULT_SERVER_LIMITS,
    rateLimiter: customRateLimiter,
    customWebUiHandler,
    managementProvider,
    consoleDataSource: customCds,
    operations,
    taskWorker,
    agentProfileApi,
    happyClawMigrationRoutes,
    extensionRoutes,
    instructionsRoutes,
    channelRoutes,
    runtimeDiagnosticsService: customRuntimeDiagnosticsService,
    auditExportService: customAuditExportService,
    usageExportService: customUsageExportService,
    taskNotificationService: customTaskNotificationService,
    modelSelectionService: customModelSelectionService,
    externalInteractionService,
    sessionLifecycleService: customSessionLifecycleService,
    runtimeArtifactPort: customRuntimeArtifactPort,
    spaceMountService,
    browserService,
    mcpService,
  } = options;

  const sessionLifecycleService = customSessionLifecycleService ?? (db && storage && customRuntimeArtifactPort ? new SessionLifecycleService({ db, storage, runtimeArtifactPort: customRuntimeArtifactPort }) : undefined);

  const runtimeDiagnosticsService = customRuntimeDiagnosticsService ?? (db ? new RuntimeDiagnosticsService({ db }) : undefined)!;
  const auditExportService = customAuditExportService ?? (db ? new AuditExportService(db) : undefined)!;
  const usageExportService = customUsageExportService ?? (db ? new UsageExportService(db) : undefined)!;
  const taskNotificationService = customTaskNotificationService ?? (db ? new TaskNotificationService({ db }) : undefined)!;
  const modelSelectionService = customModelSelectionService ?? customCds?.modelSelectionService ?? (db ? new ModelSelectionService({ db, operations }) : undefined)!;

  const fileService = options.fileService ?? (options.fileProvider ? new RuntimeFileApiService({ fileProvider: options.fileProvider, platformApi, operations }) : undefined);

  const opsProvider: ManagementOperationsProvider | undefined =
    options.operationsProvider ??
    (operations && "setQuotaLimit" in operations && typeof (operations as unknown as ManagementOperationsProvider).setQuotaLimit === "function"
      ? (operations as unknown as ManagementOperationsProvider)
      : (operations && "forTenant" in operations && typeof (operations as unknown as PlatformOperationsService).forTenant === "function"
        ? createManagementOperationsAdapter(operations)
        : undefined));

  const rateLimiter = customRateLimiter ?? new FailedLoginRateLimiter({
    maxFailedLogins: limits.maxFailedLogins,
    windowSeconds: limits.failedLoginWindowSeconds,
    storage,
  });
  const maxBodyBytes = limits.maxBodySizeBytes || 1048576;
  const cds = customCds ?? (db && storage ? new ConsoleDataSource({ database: db, storage, quotaDefaults: options.quotaDefaults ?? { tokens: -1, messages: -1, turns: -1, storage_bytes: -1, api_calls: -1 } }) : undefined)!;

  const meteredRequests = new WeakSet<IncomingMessage>();

  async function getAuthUser(req: IncomingMessage): Promise<User | null> {
    const rawCookie = req.headers.cookie;
    if (!rawCookie) return null;

    // Check duplicate cookie names
    const parts = rawCookie.split(";");
    let sessionCookieCount = 0;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith("enkeep_session=")) {
        sessionCookieCount++;
      }
    }
    if (sessionCookieCount > 1) {
      throw new UnauthorizedError("Multiple session cookies detected");
    }

    const auth = await platformApi.authenticateCookie(rawCookie);
    return auth ? (auth.user as unknown as User) : null;
  }

  async function getRequiredAuthUser(req: IncomingMessage, options?: { allowMustChangePassword?: boolean }): Promise<User> {
    const user = await getAuthUser(req);
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }
    if (user.status === "disabled") {
      throw new UnauthorizedError("Account is disabled");
    }
    if (user.mustChangePassword && !options?.allowMustChangePassword) {
      throw new PlatformError(
        "Password change required before accessing platform resources",
        "PASSWORD_CHANGE_REQUIRED",
        403
      );
    }

    // api_calls metering: Meter once per state-changing mutation request (POST, PUT, PATCH, DELETE)
    const reqMethod = (req.method || "GET").toUpperCase();
    const isMutation = reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH" || reqMethod === "DELETE";

    if (isMutation && !meteredRequests.has(req)) {
      meteredRequests.add(req);
      if (operations && typeof operations.forTenant === "function") {
        try {
          const tenantQuota = operations.forTenant(user.id).quota;
          if (tenantQuota) {
            const lim = await tenantQuota.getLimit("api_calls");
            if (lim && typeof lim.limit === "number" && lim.limit > 0) {
              const reservation = await tenantQuota.reserveQuota({
                resource: "api_calls",
                amount: 1,
                ttlSeconds: 60,
              });
              await tenantQuota.commitQuota({
                reservationId: reservation.id,
                actualAmount: 1,
              });
            }
          }
        } catch (err: unknown) {
          if (isQuotaExceededError(err)) {
            throw new PlatformError("Quota exceeded for api_calls", "QUOTA_EXCEEDED", 429);
          }
          if (err instanceof PlatformError) {
            throw err;
          }
        }
      }
    }

    return user;
  }

  return async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = parsedUrl.pathname;
    const clientIp = req.socket.remoteAddress || "127.0.0.1";

    try {
      // 0. Host Header Validation
      validateHost(req);

      // Early rejection of oversized payloads via Content-Length header
      const contentLengthHeader = req.headers["content-length"];
      if (contentLengthHeader !== undefined) {
        const parsedContentLength = Number(contentLengthHeader);
        const isUploadRoute = pathname.includes("/files/upload");
        const effectiveMaxBytes = isUploadRoute ? MAX_UPLOAD_TOTAL_BYTES : maxBodyBytes;
        if (Number.isFinite(parsedContentLength) && parsedContentLength > effectiveMaxBytes) {
          throw new PayloadTooLargeError(`Request payload size ${parsedContentLength} bytes exceeds limit of ${effectiveMaxBytes} bytes`);
        }
      }

      // 1. Health & CSRF Bootstrap
      if (pathname === "/api/health" || pathname === "/health") {
        if (method !== "GET") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        sendJsonResponse(res, 200, createSuccessEnvelope({
          status: "ok",
          service: "enkeep-platform-server",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      if (pathname === "/api/auth/csrf" || pathname === "/api/v1/auth/csrf") {
        if (method !== "GET") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        sendJsonResponse(res, 200, createSuccessEnvelope({ csrfToken }));
        return;
      }

      // 2. Readiness Endpoint
      if (pathname === "/api/readiness" || pathname === "/readiness") {
        if (method !== "GET") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        let runtimeAvailable = false;
        let runtimeStatusStr = "unavailable";
        if (managementProvider) {
          try {
            const list = await managementProvider.listRuntimes();
            if (Array.isArray(list)) {
              runtimeAvailable = true;
              runtimeStatusStr = "available";
            }
          } catch {
            runtimeAvailable = false;
            runtimeStatusStr = "error";
          }
        }

        let opsStatus: OperationsReadinessStatus = {
          producer: { available: false, unavailableReason: "OPERATIONS_PROVIDER_UNAVAILABLE" },
          worker: { available: false, running: false, unavailableReason: "WORKER_DISABLED" },
        };

        if (operations) {
          opsStatus = {
            producer: { available: true, unavailableReason: null },
            worker: taskWorker
              ? { available: true, running: true, unavailableReason: null }
              : { available: false, running: false, unavailableReason: "WORKER_DISABLED" },
          };
        }

        const isReady = opsStatus.producer.available;
        sendJsonResponse(res, 200, createSuccessEnvelope({
          status: isReady ? "ready" : "not_ready",
          available: isReady,
          runtime: {
            available: runtimeAvailable,
            status: runtimeStatusStr,
          },
          operations: opsStatus,
        }));
        return;
      }

      // 3. Auth Routes
      if (pathname === "/api/auth/login" || pathname === "/api/v1/auth/login") {
        if (method !== "POST") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        validateCsrf(req, { csrfToken });
        const body = await parseJsonBody(req, maxBodyBytes);
        const unknownKeys = getUnknownKeys(body, ALLOWED_LOGIN_KEYS);
        if (unknownKeys.length > 0) {
          throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
        }

        const rawUsername = body.username;
        const rawPassword = body.password;

        if (typeof rawUsername !== "string" || rawUsername.length === 0 || rawUsername !== rawUsername.trim() || rawUsername.length > 64) {
          throw new ValidationError("Invalid username format");
        }
        if (typeof rawPassword !== "string" || rawPassword.length === 0 || rawPassword.length > 256) {
          throw new ValidationError("Invalid password format");
        }

        await rateLimiter.checkLimit(rawUsername, clientIp);

        let loginResult: { user: unknown; cookieHeader: string };
        try {
          loginResult = await platformApi.login(rawUsername, rawPassword, {
            ipAddress: clientIp,
            userAgent: req.headers["user-agent"],
          });
        } catch (err: unknown) {
          rateLimiter.recordFailure(rawUsername, clientIp);
          throw err;
        }

        res.setHeader("Set-Cookie", loginResult.cookieHeader);
        sendJsonResponse(res, 200, createSuccessEnvelope({ user: loginResult.user }));
        return;
      }

      if (pathname === "/api/auth/logout" || pathname === "/api/v1/auth/logout") {
        if (method !== "POST") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        validateCsrf(req, { csrfToken });
        const rawCookie = req.headers.cookie;
        if (rawCookie) {
          const auth = await platformApi.authenticateCookie(rawCookie);
          if (auth?.session?.id) {
            await platformApi.logout(auth.session.id);
          }
        }
        res.setHeader(
          "Set-Cookie",
          "enkeep_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Strict"
        );
        sendJsonResponse(res, 200, createSuccessEnvelope({ loggedOut: true }));
        return;
      }

      if (pathname === "/api/auth/me" || pathname === "/api/v1/auth/me") {
        if (method !== "GET") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });
        sendJsonResponse(res, 200, createSuccessEnvelope({ user }));
        return;
      }

      if (pathname === "/api/auth/password" || pathname === "/api/v1/auth/password") {
        if (method !== "PUT") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        validateCsrf(req, { csrfToken });
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });
        const body = await parseJsonBody(req, maxBodyBytes);
        const unknownKeys = getUnknownKeys(body, new Set(["oldPassword", "newPassword"]));
        if (unknownKeys.length > 0) {
          throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
        }

        const result = await cds.changeUserPassword(user.id, body.oldPassword, body.newPassword);
        if (authService && typeof authService.rotateSession === 'function') {
          const rotated = await authService.rotateSession(user.id, {
            ipAddress: clientIp,
            userAgent: req.headers["user-agent"],
          });
          res.setHeader("Set-Cookie", rotated.cookieHeader);
        }
        sendJsonResponse(res, 200, createSuccessEnvelope(result));
        return;
      }

      // 3.0 Instructions Routes (/api/account/instructions/global or /api/spaces/:spaceId/instructions)
      if (instructionsRoutes) {
        const isAccountGlobal = pathname === "/api/account/instructions/global";
        const isSpaceInstructions = /^\/api\/spaces\/[^/]+\/instructions$/.test(pathname);
        if (isAccountGlobal || isSpaceInstructions) {
          const user = await getRequiredAuthUser(req);
          const handled = await instructionsRoutes.handle(req, res, pathname, user, parsedUrl);
          if (handled) return;
        }
      }

      // 3.1 Account Preferences Routes (/api/account/preferences)
      if (pathname === "/api/account/preferences") {
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });

        if (method === "GET") {
          const preferences = await cds.getUserPreferences(user.id);
          sendJsonResponse(res, 200, createSuccessEnvelope(preferences));
          return;
        }

        if (method === "PATCH") {
          validateCsrf(req, { csrfToken });
          const idempotencyKey = requireIdempotencyKey(req);
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_ACCOUNT_PREFERENCES_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          if (body.locale === undefined && body.theme === undefined) {
            throw new ValidationError('Field "locale" or "theme" is required');
          }

          let validatedLocale: "en" | "zh-CN" | undefined;
          if (body.locale !== undefined) {
            if (body.locale === null || typeof body.locale !== "string" || (body.locale !== "en" && body.locale !== "zh-CN")) {
              throw new ValidationError("Invalid locale value: must be 'en' or 'zh-CN'");
            }
            validatedLocale = body.locale as "en" | "zh-CN";
          }

          let validatedTheme: "dark" | "light" | "eye-care" | undefined;
          if (body.theme !== undefined) {
            if (body.theme === null || typeof body.theme !== "string" || (body.theme !== "dark" && body.theme !== "light" && body.theme !== "eye-care")) {
              throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
            }
            validatedTheme = body.theme as "dark" | "light" | "eye-care";
          }

          const updated = await cds.updateUserPreferences(
            user.id,
            { locale: validatedLocale, theme: validatedTheme },
            {
              ipAddress: clientIp,
              userAgent: req.headers["user-agent"],
              idempotencyKey,
            }
          );

          sendJsonResponse(res, 200, createSuccessEnvelope(updated));
          return;
        }

        throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
      }

      // 3.1.1 Canonical Account Theme Route (/api/account/preferences/theme)
      if (pathname === "/api/account/preferences/theme") {
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });

        if (method === "GET") {
          const themePref = await cds.getUserTheme(user.id);
          sendJsonResponse(res, 200, createSuccessEnvelope(themePref));
          return;
        }

        if (method === "PUT" || method === "PATCH") {
          validateCsrf(req, { csrfToken });
          const rawIdempotencyKey = req.headers["idempotency-key"];
          const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : undefined;
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_ACCOUNT_THEME_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          if (body.theme === undefined || body.theme === null) {
            throw new ValidationError('Field "theme" is required');
          }

          const rawTheme = body.theme;
          if (typeof rawTheme !== "string" || (rawTheme !== "dark" && rawTheme !== "light" && rawTheme !== "eye-care")) {
            throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
          }

          const updated = await cds.updateUserTheme(user.id, rawTheme as "dark" | "light" | "eye-care", {
            ipAddress: clientIp,
            userAgent: req.headers["user-agent"],
            idempotencyKey,
          });

          sendJsonResponse(res, 200, createSuccessEnvelope(updated));
          return;
        }

        throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
      }

      // 3.2 Account Model Override Routes (/api/account/model-override)
      if (pathname === "/api/account/model-override") {
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });

        if (method === "GET") {
          const override = await modelSelectionService.getOverride("user", user.id);
          sendJsonResponse(res, 200, createSuccessEnvelope(override));
          return;
        }

        if (method === "PUT" || method === "PATCH") {
          validateCsrf(req, { csrfToken });
          const rawHeader = req.headers["if-match"];
          if (Array.isArray(rawHeader)) {
            throw new ValidationError('Multiple or duplicate "If-Match" headers are not allowed');
          }
          const ifMatchHeader = typeof rawHeader === "string" ? rawHeader : undefined;

          const rawBody = await parseJsonBody(req, maxBodyBytes);
          if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
            throw new ValidationError("Request body cannot be empty");
          }
          const unknownKeys = getUnknownKeys(rawBody, ALLOWED_MODEL_OVERRIDE_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          if (typeof rawBody.provider !== "string" || !rawBody.provider.trim()) {
            throw new ValidationError('Field "provider" must be a non-empty string');
          }
          if (typeof rawBody.model !== "string" || !rawBody.model.trim()) {
            throw new ValidationError('Field "model" must be a non-empty string');
          }
          if (rawBody.reasoningEffort !== undefined && typeof rawBody.reasoningEffort !== "string" && rawBody.reasoningEffort !== null) {
            throw new ValidationError('Field "reasoningEffort" must be a string or null');
          }
          if (rawBody.fallbackChain !== undefined && !Array.isArray(rawBody.fallbackChain) && rawBody.fallbackChain !== null) {
            throw new ValidationError('Field "fallbackChain" must be an array or null');
          }

          const ifMatch = (typeof rawBody.ifMatch === "string" ? rawBody.ifMatch : undefined) ?? ifMatchHeader;

          const updated = await modelSelectionService.setOverride(
            user.id,
            "user",
            user.id,
            {
              provider: rawBody.provider,
              model: rawBody.model,
              reasoningEffort: typeof rawBody.reasoningEffort === "string" ? rawBody.reasoningEffort : null,
              fallbackChain: Array.isArray(rawBody.fallbackChain) ? rawBody.fallbackChain : null,
              ifMatch,
            },
            user.id
          );

          sendJsonResponse(res, 200, createSuccessEnvelope(updated));
          return;
        }

        if (method === "DELETE") {
          validateCsrf(req, { csrfToken });
          const deleted = await modelSelectionService.deleteOverride("user", user.id, user.id);
          sendJsonResponse(res, 200, createSuccessEnvelope({ deleted }));
          return;
        }

        throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
      }

      // 4. Privileged DSH Guard
      if (pathname === "/api/dsh" || pathname.startsWith("/api/dsh/")) {
        const user = await getRequiredAuthUser(req);
        if (user.role !== "admin") {
          throw new ForbiddenError("Administrative access required");
        }
        if (method === "GET") {
          sendJsonResponse(res, 200, createSuccessEnvelope({
            mode: "privileged",
            capability: "status_only",
            directExecution: false,
            adminUser: user.username,
            status: "running",
            message: "Direct execution API is not supported; status query only",
            capabilities: ["web-chat", "spaces", "sessions", "profiles", "operations", "files"],
          }));
          return;
        }
        throw new PlatformError(
          "Direct execution mutation via /api/dsh/* is not supported; use standard /api/sessions and /api/manage endpoints",
          "METHOD_NOT_ALLOWED",
          405
        );
      }

      // 5. Spaces Routes (/api/spaces)
      if (pathname === "/api/spaces") {
        const user = await getRequiredAuthUser(req);

        if (method === "GET") {
          const incArchivedRaw = parsedUrl.searchParams.get("includeArchived");
          let includeArchived = false;
          if (incArchivedRaw !== null) {
            if (incArchivedRaw === "true") includeArchived = true;
            else if (incArchivedRaw === "false") includeArchived = false;
            else throw new ValidationError('Invalid "includeArchived" query parameter');
          }
          const spaces = await platformApi.listSpaces(user.id, { includeArchived });
          sendJsonResponse(res, 200, createSuccessEnvelope(spaces));
          return;
        }

        if (method === "POST") {
          validateCsrf(req, { csrfToken });
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_CREATE_SPACE_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          const name = validateResourceName(body.name, "name");
          if (body.folder === undefined || body.folder === null) {
            throw new ValidationError('Field "folder" is required');
          }
          if (typeof body.folder !== "string" || !body.folder.trim()) {
            throw new ValidationError('Field "folder" must be a non-empty string');
          }
          if (body.folder.startsWith("/") || body.folder.includes("..") || body.folder.includes("/") || body.folder.includes("\\")) {
            throw new ValidationError('Field "folder" must be a relative single directory name and cannot contain path separators');
          }
          const folder = validateResourceName(body.folder, "folder");

          let executionMode: "container" | "host" = "container";
          if (body.executionMode !== undefined) {
            if (body.executionMode !== "container" && body.executionMode !== "host") {
              throw new ValidationError('Invalid executionMode: Expected container or host');
            }
            executionMode = body.executionMode;
          }

          if (executionMode === "host") {
            if (!canManageHostRuntime(user)) {
              throw new ForbiddenError('Only administrators can manage host execution mode');
            }
          }

          const space = await platformApi.createSpace(user.id, {
            name,
            folder,
            executionMode,
          } as any);
          sendJsonResponse(res, 201, createSuccessEnvelope({
            ...space,
            folder,
            executionMode: space.executionMode ?? executionMode,
          }));
          return;
        }
      }

      // 5.1 Space Sub-resources: /api/spaces/:spaceId/*
      const spaceSubMatch = pathname.match(/^\/api\/spaces\/([^/]+)(.*)$/);
      if (spaceSubMatch) {
        const user = await getRequiredAuthUser(req);
        const spaceId = validatePathId(spaceSubMatch[1], "spaceId");
        const subPath = spaceSubMatch[2];

        // 5.1.1 /api/spaces/:spaceId (Space Detail, Update, Delete)
        if (subPath === "" || subPath === "/") {
          if (method === "GET") {
            const space = await platformApi.getSpace(user.id, spaceId);
            if (!space) {
              throw new NotFoundError(`Space "${spaceId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(space));
            return;
          }

          if (method === "PATCH") {
            validateCsrf(req, { csrfToken });
            const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, ALLOWED_UPDATE_SPACE_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            const existing = await platformApi.getSpace(user.id, spaceId);
            if (!existing) {
              throw new NotFoundError(`Space "${spaceId}" not found`);
            }

            if (body.executionMode !== undefined) {
              if (body.executionMode !== "container" && body.executionMode !== "host") {
                throw new ValidationError('Invalid executionMode: Expected container or host');
              }
              if (body.executionMode !== existing.executionMode) {
                throw new ConflictError('Switching space execution mode requires migration', 'MIGRATION_REQUIRED');
              }
              if (body.executionMode === "host" || existing.executionMode === "host") {
                if (!canManageHostRuntime(user)) {
                  throw new ForbiddenError('Only administrators can manage host execution mode');
                }
              }
            }

            const updatePayload: { name?: string; executionMode?: "container" | "host" } = {};
            if (body.name !== undefined) {
              updatePayload.name = validateResourceName(body.name, "name");
            }
            if (body.executionMode !== undefined) {
              updatePayload.executionMode = body.executionMode;
            }

            const updated = await platformApi.updateSpace(user.id, spaceId, updatePayload);
            if (!updated) {
              throw new NotFoundError(`Space "${spaceId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(updated));
            return;
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
              const space = await platformApi.getSpace(user.id, spaceId);
            if (!space) {
              throw new NotFoundError(`Space "${spaceId}" not found`);
            }
            const archived = await platformApi.archiveSpace(user.id, spaceId);
            sendJsonResponse(res, 200, createSuccessEnvelope(archived));
            return;
          }
        }

        // 5.1.2 /api/spaces/:spaceId/archive
        if (subPath === "/archive") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await readBody(req, maxBodyBytes);
          if (rawBody.trim().length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              throw new ValidationError("Malformed JSON body");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
              throw new ValidationError("Archive request body must be empty or empty object");
            }
          }
          const space = await platformApi.getSpace(user.id, spaceId);
          if (!space) {
            throw new NotFoundError(`Space "${spaceId}" not found`);
          }
          const archived = await platformApi.archiveSpace(user.id, spaceId);
          sendJsonResponse(res, 200, createSuccessEnvelope(archived));
          return;
        }

        // 5.1.2b /api/spaces/:spaceId/restore
        if (subPath === "/restore") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await readBody(req, maxBodyBytes);
          if (rawBody.trim().length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              throw new ValidationError("Malformed JSON body");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
              throw new ValidationError("Restore request body must be empty or empty object");
            }
          }
          const restored = await platformApi.restoreSpace(user.id, spaceId);
          sendJsonResponse(res, 200, createSuccessEnvelope(restored));
          return;
        }

        // 5.1.3 /api/spaces/:spaceId/sessions
        if (subPath === "/sessions") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const space = await platformApi.getSpace(user.id, spaceId);
          if (!space) {
            throw new NotFoundError(`Space "${spaceId}" not found`);
          }
          const sessions = await platformApi.listSessions(user.id, { spaceId });
          sendJsonResponse(res, 200, createSuccessEnvelope(sessions));
          return;
        }

        // 5.1.4 /api/spaces/:spaceId/agent-profile
        if (subPath === "/agent-profile") {
          if (!agentProfileApi) {
            throw new PlatformError("Agent Profile service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }

          if (method === "POST") {
            validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, ALLOWED_SPACE_BIND_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }
            if (typeof body.profileId !== "string" || !body.profileId.trim()) {
              throw new ValidationError("profileId must be a non-empty string");
            }
            const profileId = validatePathId(body.profileId, "profileId");
            const version = body.version !== undefined ? Number(body.version) : undefined;
            const bound = await agentProfileApi.bindSpaceProfile(user.id, spaceId, { profileId, version });
            sendJsonResponse(res, 200, createSuccessEnvelope(bound));
            return;
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
              const unbound = await agentProfileApi.unbindSpaceProfile(user.id, spaceId);
            sendJsonResponse(res, 200, createSuccessEnvelope(unbound));
            return;
          }

          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        // 5.1.4b /api/spaces/:spaceId/model-override
        if (subPath === "/model-override") {
          const space = await platformApi.getSpace(user.id, spaceId);
          if (!space) {
            throw new NotFoundError(`Space "${spaceId}" not found`);
          }

          if (method === "GET") {
            const override = await modelSelectionService.getOverride("space", spaceId);
            sendJsonResponse(res, 200, createSuccessEnvelope(override));
            return;
          }

          if (method === "PUT" || method === "PATCH") {
            validateCsrf(req, { csrfToken });
            const rawHeader = req.headers["if-match"];
            if (Array.isArray(rawHeader)) {
              throw new ValidationError('Multiple or duplicate "If-Match" headers are not allowed');
            }
            const ifMatchHeader = typeof rawHeader === "string" ? rawHeader : undefined;

            const rawBody = await parseJsonBody(req, maxBodyBytes);
            if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
              throw new ValidationError("Request body cannot be empty");
            }
            const unknownKeys = getUnknownKeys(rawBody, ALLOWED_MODEL_OVERRIDE_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            if (typeof rawBody.provider !== "string" || !rawBody.provider.trim()) {
              throw new ValidationError('Field "provider" must be a non-empty string');
            }
            if (typeof rawBody.model !== "string" || !rawBody.model.trim()) {
              throw new ValidationError('Field "model" must be a non-empty string');
            }
            if (rawBody.reasoningEffort !== undefined && typeof rawBody.reasoningEffort !== "string" && rawBody.reasoningEffort !== null) {
              throw new ValidationError('Field "reasoningEffort" must be a string or null');
            }
            if (rawBody.fallbackChain !== undefined && !Array.isArray(rawBody.fallbackChain) && rawBody.fallbackChain !== null) {
              throw new ValidationError('Field "fallbackChain" must be an array or null');
            }

            const ifMatch = (typeof rawBody.ifMatch === "string" ? rawBody.ifMatch : undefined) ?? ifMatchHeader;

            const updated = await modelSelectionService.setOverride(
              user.id,
              "space",
              spaceId,
              {
                provider: rawBody.provider,
                model: rawBody.model,
                reasoningEffort: typeof rawBody.reasoningEffort === "string" ? rawBody.reasoningEffort : null,
                fallbackChain: Array.isArray(rawBody.fallbackChain) ? rawBody.fallbackChain : null,
                ifMatch,
              },
              user.id
            );

            sendJsonResponse(res, 200, createSuccessEnvelope(updated));
            return;
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
            const deleted = await modelSelectionService.deleteOverride("space", spaceId, user.id);
            sendJsonResponse(res, 200, createSuccessEnvelope({ deleted }));
            return;
          }

          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        // 5.1.5 Space Files: /api/spaces/:spaceId/files*
        if (subPath.startsWith("/files")) {
          if (!fileService) {
            throw new PlatformError("Runtime files service is unavailable in current deployment configuration", "SERVICE_UNAVAILABLE", 503);
          }

          const fileSub = subPath.slice("/files".length);

          if (fileSub === "" || fileSub === "/") {
            // GET: list files, DELETE: delete file
            if (method === "GET") {
              if (parsedUrl.searchParams.get("folder") !== null || parsedUrl.searchParams.get("userId") !== null) {
                throw new ValidationError("folder/userId parameters are strictly forbidden");
              }
              const filePath = parsedUrl.searchParams.get("path") || ".";
              const result = await fileService.execute(user.id, spaceId, { op: "list", path: filePath });
              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }

            if (method === "DELETE") {
              validateCsrf(req, { csrfToken });
                  let filePath = parsedUrl.searchParams.get("path");
              let expectedEtag = parsedUrl.searchParams.get("expectedEtag") || undefined;

              const rawBody = await readBody(req, maxBodyBytes);
              if (rawBody.trim().length > 0) {
                let body: any;
                try {
                  body = JSON.parse(rawBody);
                } catch {
                  throw new ValidationError("Malformed JSON body");
                }
                if (body && typeof body === "object" && !Array.isArray(body)) {
                  const unknownKeys = getUnknownKeys(body, ALLOWED_FILE_DELETE_KEYS);
                  if (unknownKeys.length > 0) {
                    throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                  }
                  if (typeof body.path === "string") {
                    filePath = body.path;
                  }
                  if (typeof body.expectedEtag === "string") {
                    expectedEtag = body.expectedEtag;
                  }
                }
              }

              if (!filePath) {
                throw new ValidationError('Missing required "path" parameter');
              }
              if (filePath === "." || filePath === "/" || filePath === "" || filePath === "./") {
                throw new ForbiddenError("Deleting space root directory is strictly prohibited");
              }
              if (!expectedEtag || typeof expectedEtag !== "string" || !expectedEtag.trim()) {
                throw new ValidationError('Missing required "expectedEtag" parameter for deletion');
              }

              const result = await fileService.execute(user.id, spaceId, {
                op: "delete",
                path: filePath,
                expectedEtag,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope({
                ...result,
                deleted: true,
              }));
              return;
            }
          }

          if (fileSub === "/content") {
            if (method === "GET") {
              const filePath = parsedUrl.searchParams.get("path");
              if (!filePath || !filePath.trim()) {
                throw new ValidationError('Missing required "path" parameter');
              }
              const result = await fileService.execute(user.id, spaceId, { op: "read", path: filePath });
              if (result.op === "read") {
                const etagHeader = result.etag.startsWith('"') ? result.etag : `"${result.etag}"`;
                sendJsonResponse(res, 200, createSuccessEnvelope({
                  ...result,
                  etag: etagHeader,
                }), {
                  "ETag": etagHeader,
                });
                return;
              }
              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }

            if (method === "PUT") {
              validateCsrf(req, { csrfToken });
                  const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, ALLOWED_FILE_WRITE_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }

              if (typeof body.path !== "string" || !body.path.trim()) {
                throw new ValidationError('Missing required "path" parameter');
              }
              if (typeof body.content !== "string") {
                throw new ValidationError('Missing required "content" parameter');
              }

              const hasExpectedEtag = typeof body.expectedEtag === "string" && body.expectedEtag.trim().length > 0;
              const hasRequireAbsent = body.requireAbsent === true;

              if ((hasExpectedEtag && hasRequireAbsent) || (!hasExpectedEtag && !hasRequireAbsent)) {
                throw new ValidationError('Writing a file requires exactly one of "expectedEtag" (string) or "requireAbsent: true" in request body');
              }

              let writeReq: CanonicalWriteRequest;
              if (hasExpectedEtag) {
                writeReq = {
                  op: "write",
                  path: body.path as string,
                  content: body.content as string,
                  expectedEtag: body.expectedEtag as string,
                };
              } else {
                writeReq = {
                  op: "write",
                  path: body.path as string,
                  content: body.content as string,
                  requireAbsent: true,
                };
              }

              const result = await fileService.execute(user.id, spaceId, writeReq);
              if (result.op === "write") {
                const etagHeader = result.etag.startsWith('"') ? result.etag : `"${result.etag}"`;
                sendJsonResponse(res, 200, createSuccessEnvelope({
                  ...result,
                  written: true,
                  etag: etagHeader,
                }), {
                  "ETag": etagHeader,
                });
                return;
              }
              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }
          }

          if (fileSub === "/mkdir") {
            if (method === "POST") {
              validateCsrf(req, { csrfToken });
                  const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, ALLOWED_FILE_MKDIR_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }
              if (typeof body.path !== "string" || !body.path.trim()) {
                throw new ValidationError('Missing required "path" parameter');
              }
              const result = await fileService.execute(user.id, spaceId, {
                op: "mkdir",
                path: body.path as string,
                requireAbsent: true,
              });
              sendJsonResponse(res, 201, createSuccessEnvelope({
                ...result,
                created: true,
              }));
              return;
            }
          }

          if (fileSub === "/download") {
            if (method !== "GET" && method !== "HEAD") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }

            const rawPath = parsedUrl.searchParams.get("path");
            if (!rawPath || !rawPath.trim()) {
              throw new ValidationError('Missing required "path" parameter');
            }

            // Note: Download does not decrement quota and does not count as mutation API call
            const rangeHeader = req.headers["range"] as string | undefined;

            // First check if range request was specified
            let range: { start: number; end: number } | null = null;
            if (rangeHeader) {
              const rangeMatch = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
              if (!rangeMatch) {
                throw new ValidationError("Invalid Range header format");
              }
              range = {
                start: parseInt(rangeMatch[1], 10),
                end: rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : Infinity,
              };
            }

            const streamRes = await fileService.readBinaryStream(user.id, spaceId, {
              path: rawPath,
              range: range && Number.isFinite(range.end) ? (range as { start: number; end: number }) : undefined,
            });

            if (streamRes.op !== "read" || (streamRes as any).type !== "file") {
              throw new ValidationError("Cannot download non-file or directory target");
            }

            const totalSize = streamRes.totalSize;
            const etagHeader = streamRes.etag.startsWith('"') ? streamRes.etag : `"${streamRes.etag}"`;

            // Caching check
            const ifNoneMatch = req.headers["if-none-match"];
            if (ifNoneMatch && (ifNoneMatch === etagHeader || ifNoneMatch === "*")) {
              if (streamRes.stream && typeof (streamRes.stream as any).destroy === "function") {
                (streamRes.stream as any).destroy();
              }
              res.writeHead(304, {
                "ETag": etagHeader,
                "Cache-Control": "private, no-cache, no-transform",
              });
              res.end();
              return;
            }

            const filename = rawPath.split("/").pop() || "download";
            const contentType = sniffMimeType(filename);
            const contentDisposition = buildContentDispositionHeader(filename, "attachment");

            const actualRange = streamRes.range;
            const statusCode = actualRange ? 206 : 200;
            const headers: Record<string, string | number> = {
              "Content-Type": contentType,
              "Content-Disposition": contentDisposition,
              "ETag": etagHeader,
              "Accept-Ranges": "bytes",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "Cache-Control": "private, no-cache, no-transform",
            };

            if (actualRange) {
              headers["Content-Range"] = `bytes ${actualRange.start}-${actualRange.end}/${totalSize}`;
              headers["Content-Length"] = streamRes.size;
            } else {
              headers["Content-Length"] = totalSize;
            }

            res.writeHead(statusCode, headers);

            if (method === "HEAD") {
              res.end();
              return;
            }

            await new Promise<void>((resolve, reject) => {
              streamRes.stream.on("error", (err) => {
                if (!res.headersSent) {
                  reject(err);
                } else {
                  res.destroy(err);
                  resolve();
                }
              });
              streamRes.stream.on("end", () => {
                res.end();
                resolve();
              });
              streamRes.stream.pipe(res);
            });
            return;
          }

          if (fileSub === "/upload") {
            if (method !== "POST") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }

            validateCsrf(req, { csrfToken });
            const idempotencyKey = requireIdempotencyKey(req);

            const rawPath = parsedUrl.searchParams.get("path") || ".";
            const overwriteParam = parsedUrl.searchParams.get("overwrite");
            const overwrite = overwriteParam === "true";

            // Strict If-Match validation
            const rawIfMatch = req.headers["if-match"];
            let cleanIfMatch: string | undefined;
            if (rawIfMatch !== undefined) {
              if (Array.isArray(rawIfMatch)) {
                throw new ValidationError('Multiple or duplicate "If-Match" headers are not allowed');
              }
              if (typeof rawIfMatch === "string" && rawIfMatch.includes(",")) {
                throw new ValidationError('Multiple or comma-separated "If-Match" values are not allowed');
              }
              cleanIfMatch = typeof rawIfMatch === "string" ? rawIfMatch.trim() : undefined;
            }

            if (overwrite && !cleanIfMatch) {
              throw new ValidationError('Header "If-Match" is required when overwrite=true');
            }
            if (!overwrite && cleanIfMatch) {
              throw new ValidationError('"If-Match" header is not permitted when overwrite is false');
            }

            const contentTypeHeader = req.headers["content-type"] || "";
            const isMultipart = contentTypeHeader.includes("multipart/form-data");

            if (isMultipart) {
              const { normalizedPath: relDir } = validateRelativeFilePath(rawPath, { allowRoot: true });

              let bb: Busboy.Busboy;
              try {
                bb = Busboy({
                  headers: req.headers,
                  defParamCharset: "utf8",
                  preservePath: true,
                  limits: {
                    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
                    files: MAX_UPLOAD_FILES_COUNT,
                    fields: 0,
                  },
                });
              } catch {
                throw new ValidationError("Invalid multipart payload: missing boundary or malformed headers");
              }

              let filesUploaded: Array<{
                filename: string;
                path: string;
                size: number;
                etag: string;
                mtimeMs: number;
              }> = [];

              let fileCount = 0;
              let busboyError: Error | null = null;
              const filePromises: Promise<void>[] = [];

              bb.on("field", () => {
                busboyError = new ValidationError("Form fields are not permitted in file upload request");
              });

              bb.on("file", (_name: string, fileStream: NodeJS.ReadableStream, info: Busboy.FileInfo) => {
                fileCount++;
                if (fileCount > MAX_UPLOAD_FILES_COUNT) {
                  const err = new PlatformError("Too many files in request (maximum 1 file per upload request)", "PAYLOAD_TOO_LARGE", 413);
                  busboyError = err;
                  fileStream.resume();
                  return;
                }

                const rawFilename = info.filename;
                let sanitizedFilename: string;
                try {
                  sanitizedFilename = sanitizeMultipartFilename(rawFilename);
                } catch (sanErr: unknown) {
                  busboyError = sanErr instanceof Error ? sanErr : new ValidationError("Invalid filename");
                  fileStream.resume();
                  return;
                }

                const destRelativePath = relDir === "." || relDir === ""
                  ? sanitizedFilename
                  : `${relDir}/${sanitizedFilename}`;

                // Validate the full destination path
                try {
                  validateRelativeFilePath(destRelativePath, { allowRoot: false });
                } catch (pathErr: unknown) {
                  busboyError = pathErr instanceof Error ? pathErr : new ValidationError("Invalid path");
                  fileStream.resume();
                  return;
                }

                const writePromise = (async () => {
                  let stageToken: string | undefined;
                  try {
                    const limiter = new ByteLimitTransform(MAX_UPLOAD_FILE_SIZE_BYTES);

                    fileStream.on("error", (fErr) => {
                      limiter.destroy(fErr);
                    });

                    fileStream.pipe(limiter);

                    // Phase 1: Stream to staging temp file and compute content SHA256
                    const stageRes = await fileService.stageBinaryStream(
                      user.id,
                      spaceId,
                      {
                        path: destRelativePath,
                        maxSizeBytes: MAX_UPLOAD_FILE_SIZE_BYTES,
                      },
                      limiter
                    );
                    stageToken = stageRes.stageToken;

                    const requestHash = computeUploadRequestHash({
                      userId: user.id,
                      spaceId,
                      path: destRelativePath,
                      overwrite,
                      expectedEtag: cleanIfMatch,
                      contentSha256: stageRes.sha256,
                    });

                    const journalId = `jrn_${randomUUID().replace(/-/g, "")}`;
                    const rollbackToken = overwrite ? `.${destRelativePath.split("/").pop() || "file"}.${journalId.slice(4, 20)}.rollback.tmp` : undefined;

                    // Idempotency check with content SHA-256
                    if (db) {
                      const idempRow = db.prepare(
                        `SELECT target_id, request_hash, response_payload
                         FROM operation_idempotency
                         WHERE user_id = ? AND scope = 'file_upload' AND idempotency_key = ?
                         LIMIT 1`
                      ).get(user.id, idempotencyKey) as { target_id: string; request_hash: string; response_payload: string } | undefined;

                      if (idempRow) {
                        await fileService.abortStage(user.id, spaceId, { path: destRelativePath, stageToken: stageRes.stageToken });
                        stageToken = undefined;

                        if (idempRow.request_hash === requestHash && idempRow.target_id === `${spaceId}:${destRelativePath}`) {
                          const parsedPayload = JSON.parse(idempRow.response_payload);
                          if (isRecord(parsedPayload) && parsedPayload.uploaded === true && Array.isArray(parsedPayload.files)) {
                            filesUploaded = parsedPayload.files as any;
                            return;
                          }
                        }
                        throw new PlatformError("Idempotency key reused with different upload request parameters", "IDEMPOTENCY_CONFLICT", 409);
                      }

                      const preResponsePayload = JSON.stringify({
                        uploaded: true,
                        files: [{
                          filename: sanitizedFilename,
                          path: destRelativePath,
                          size: stageRes.size,
                          etag: stageRes.etag,
                          mtimeMs: 0,
                        }],
                        count: 1,
                        totalBytes: stageRes.size,
                        idempotencyKey,
                        etag: stageRes.etag,
                      });

                      // Insert journal in staged state BEFORE physical commit
                      db.prepare(`
                        INSERT INTO file_transfer_journal (
                          id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                      `).run(
                        journalId,
                        user.id,
                        spaceId,
                        destRelativePath,
                        stageRes.stageToken,
                        rollbackToken || null,
                        overwrite ? 1 : 0,
                        cleanIfMatch || null,
                        stageRes.sha256,
                        stageRes.size,
                        idempotencyKey,
                        preResponsePayload
                      );
                    }

                    // Phase 2: Commit stage atomically with deterministic rollback token
                    const writeRes = await fileService.commitStage(
                      user.id,
                      spaceId,
                      {
                        path: destRelativePath,
                        stageToken: stageRes.stageToken,
                        rollbackToken,
                        expectedEtag: cleanIfMatch,
                        requireAbsent: !overwrite ? true : undefined,
                      }
                    );
                    stageToken = undefined;

                    // Immediately CAS update journal to committed state with real response payload
                    if (db) {
                      const committedResponsePayload = JSON.stringify({
                        uploaded: true,
                        files: [{
                          filename: sanitizedFilename,
                          path: destRelativePath,
                          size: writeRes.size,
                          etag: writeRes.etag,
                          mtimeMs: writeRes.mtimeMs,
                        }],
                        count: 1,
                        totalBytes: writeRes.size,
                        idempotencyKey,
                        etag: writeRes.etag,
                      });

                      let committedUpdated = false;
                      let commitUpdateErr: unknown;
                      try {
                        const casRes = db.prepare(`
                          UPDATE file_transfer_journal
                          SET status = 'committed', rollback_token = ?, response_payload = ?, updated_at = CURRENT_TIMESTAMP
                          WHERE id = ? AND status = 'staged'
                        `).run(
                          writeRes.rollbackToken || null,
                          committedResponsePayload,
                          journalId
                        );
                        committedUpdated = casRes.changes === 1;
                      } catch (cErr: unknown) {
                        commitUpdateErr = cErr;
                        committedUpdated = false;
                      }

                      if (!committedUpdated) {
                        const rollbackErrors: unknown[] = [];
                        if (commitUpdateErr) {
                          rollbackErrors.push(commitUpdateErr);
                        }

                        try {
                          await fileService.rollbackCommit(user.id, spaceId, {
                            path: destRelativePath,
                            rollbackToken: writeRes.rollbackToken,
                            expectedEtag: writeRes.etag,
                          });
                        } catch (rbErr: unknown) {
                          rollbackErrors.push(rbErr);
                        }

                        try {
                          db.prepare(`
                            UPDATE file_transfer_journal
                            SET status = 'rolled_back', updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                          `).run(journalId);
                        } catch (rbDbErr: unknown) {
                          rollbackErrors.push(rbDbErr);
                        }

                        if (rollbackErrors.length > 0) {
                          const primary = commitUpdateErr instanceof Error ? commitUpdateErr : new Error('Failed to record committed stage status in journal');
                          throw new PlatformError(
                            `Failed to record committed state and rollback encountered error: ${primary.message}`,
                            'SERVICE_UNAVAILABLE',
                            503
                          );
                        }

                        throw new PlatformError('Failed to record committed stage status in journal', 'SERVICE_UNAVAILABLE', 503);
                      }
                    }

                    filesUploaded.push({
                      filename: sanitizedFilename,
                      path: destRelativePath,
                      size: writeRes.size,
                      etag: writeRes.etag,
                      mtimeMs: writeRes.mtimeMs,
                    });

                    // Phase 3: Atomic DB Finalization (Idempotency + Audit Log + Journal Finalize)
                    if (db) {
                      const responsePayload = JSON.stringify({
                        uploaded: true,
                        files: [{
                          filename: sanitizedFilename,
                          path: destRelativePath,
                          size: writeRes.size,
                          etag: writeRes.etag,
                          mtimeMs: writeRes.mtimeMs,
                        }],
                        count: 1,
                        totalBytes: writeRes.size,
                        idempotencyKey,
                        etag: writeRes.etag,
                      });

                      let startedTx = false;
                      try {
                        db.exec("BEGIN IMMEDIATE");
                        startedTx = true;

                        db.prepare(`
                          UPDATE file_transfer_journal
                          SET status = 'finalized', rollback_token = ?, response_payload = ?, updated_at = CURRENT_TIMESTAMP
                          WHERE id = ? AND status IN ('committed', 'staged')
                        `).run(
                          writeRes.rollbackToken || null,
                          responsePayload,
                          journalId
                        );

                        db.prepare(`
                          INSERT INTO operation_idempotency (
                            id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
                          ) VALUES (?, ?, 'file_upload', ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        `).run(
                          `idemp_${randomUUID().replace(/-/g, "")}`,
                          user.id,
                          idempotencyKey,
                          `${spaceId}:${destRelativePath}`,
                          requestHash,
                          responsePayload
                        );

                        db.prepare(`
                          INSERT INTO auth_audit_log (
                            id, user_id, username, action, ip_address, user_agent, details, created_at
                          ) VALUES (?, ?, ?, 'file_uploaded', ?, ?, ?, CURRENT_TIMESTAMP)
                        `).run(
                          `audit_${randomUUID().replace(/-/g, "")}`,
                          user.id,
                          user.username || user.id,
                          clientIp,
                          req.headers["user-agent"] ?? null,
                          JSON.stringify({
                            resourceType: "file",
                            spaceId,
                            filename: sanitizedFilename,
                            path: destRelativePath,
                            size: writeRes.size,
                            etag: writeRes.etag,
                          })
                        );

                        db.exec("COMMIT");
                        startedTx = false;

                        // Finalize stage backup
                        if (writeRes.rollbackToken) {
                          try {
                            await fileService.finalizeStage(user.id, spaceId, {
                              path: destRelativePath,
                              rollbackToken: writeRes.rollbackToken,
                            });
                          } catch (finErr: unknown) {
                            // If backup unlink fails, mark journal cleanup_pending
                            try {
                              db.prepare(`
                                UPDATE file_transfer_journal
                                SET status = 'cleanup_pending', updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?
                              `).run(journalId);
                            } catch (cpErr: unknown) {
                              // Log or aggregate error
                            }
                          }
                        }
                      } catch (dbErr: unknown) {
                        const cleanupErrors: unknown[] = [dbErr];
                        if (startedTx) {
                          try {
                            db.exec("ROLLBACK");
                          } catch (rbErr: unknown) {
                            cleanupErrors.push(rbErr);
                          }
                        }

                        // Compensation rollback of physical file
                        try {
                          await fileService.rollbackCommit(user.id, spaceId, {
                            path: destRelativePath,
                            rollbackToken: writeRes.rollbackToken,
                            expectedEtag: writeRes.etag,
                          });
                        } catch (fileRbErr: unknown) {
                          cleanupErrors.push(fileRbErr);
                        }

                        try {
                          db.prepare(`
                            UPDATE file_transfer_journal
                            SET status = 'rolled_back', updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                          `).run(journalId);
                        } catch (rbJournalErr: unknown) {
                          cleanupErrors.push(rbJournalErr);
                        }

                        const primary = dbErr instanceof Error ? dbErr : new Error(String(dbErr));
                        if (cleanupErrors.length > 1) {
                          const agg = new AggregateError(cleanupErrors, `Failed to finalize file upload transaction: ${primary.message}`);
                          throw new PlatformError(agg.message, "SERVICE_UNAVAILABLE", 503);
                        }
                        throw new PlatformError(`Failed to finalize file upload transaction: ${primary.message}`, "SERVICE_UNAVAILABLE", 503);
                      }
                    }
                  } catch (wErr: unknown) {
                    if (stageToken) {
                      try {
                        await fileService.abortStage(user.id, spaceId, { path: destRelativePath, stageToken });
                      } catch (abortErr: unknown) {
                        // Abort stage failed
                      }
                    }
                    if (!busboyError) {
                      busboyError = wErr instanceof Error ? wErr : new Error(String(wErr));
                    }
                    throw wErr;
                  }
                })();

                filePromises.push(writePromise);
              });

              await new Promise<void>((resolve, reject) => {
                bb.on("filesLimit", () => {
                  busboyError = new PlatformError("Too many files in request (maximum 1 file per upload request)", "PAYLOAD_TOO_LARGE", 413);
                });
                bb.on("partsLimit", () => {
                  busboyError = new PlatformError("Too many parts in request", "PAYLOAD_TOO_LARGE", 413);
                });
                bb.on("error", () => {
                  busboyError = new ValidationError("Invalid multipart payload: malformed multipart stream");
                  reject(busboyError);
                });
                bb.on("finish", () => {
                  resolve();
                });
                req.pipe(bb);
              });

              if (busboyError) {
                throw busboyError;
              }

              try {
                await Promise.all(filePromises);
              } catch (pErr: unknown) {
                if (busboyError) throw busboyError;
                throw pErr;
              }

              if (busboyError) {
                throw busboyError;
              }

              if (filesUploaded.length === 0) {
                // If idempotent replay
                if (db) {
                  const idempRow = db.prepare(
                    `SELECT response_payload
                     FROM operation_idempotency
                     WHERE user_id = ? AND scope = 'file_upload' AND idempotency_key = ?
                     LIMIT 1`
                  ).get(user.id, idempotencyKey) as { response_payload: string } | undefined;

                  if (idempRow) {
                    const parsedPayload = JSON.parse(idempRow.response_payload);
                    if (isRecord(parsedPayload) && parsedPayload.uploaded === true && Array.isArray(parsedPayload.files)) {
                      sendJsonResponse(res, 201, createSuccessEnvelope({
                        uploaded: true,
                        files: parsedPayload.files,
                        count: parsedPayload.count ?? 1,
                        totalBytes: parsedPayload.totalBytes ?? 0,
                        idempotencyKey,
                        etag: parsedPayload.etag,
                        isIdempotentHit: true,
                      }), {
                        "ETag": parsedPayload.etag || (parsedPayload.files?.[0]?.etag ?? ""),
                      });
                      return;
                    }
                  }
                }
                throw new ValidationError("No files provided in multipart upload request");
              }

              sendJsonResponse(res, 201, createSuccessEnvelope({
                uploaded: true,
                files: filesUploaded,
                count: filesUploaded.length,
                totalBytes: filesUploaded.reduce((acc, f) => acc + f.size, 0),
                idempotencyKey,
              }));
              return;
            } else {
              // Direct binary stream upload (PUT / POST octet-stream)
              const { normalizedPath: targetPath } = validateRelativeFilePath(rawPath, { allowRoot: false });

              const limiter = new ByteLimitTransform(MAX_UPLOAD_FILE_SIZE_BYTES);
              req.on("close", () => {
                if (!req.complete) {
                  limiter.destroy(new PlatformError("Request aborted by client", "CLIENT_ABORTED", 499));
                }
              });
              req.pipe(limiter);

              // Phase 1: Stream to staging temp file and compute SHA256
              let stageToken: string | undefined;
              let stageRes;
              try {
                stageRes = await fileService.stageBinaryStream(
                  user.id,
                  spaceId,
                  {
                    path: targetPath,
                    maxSizeBytes: MAX_UPLOAD_FILE_SIZE_BYTES,
                  },
                  limiter
                );
                stageToken = stageRes.stageToken;
              } catch (stageErr: unknown) {
                throw stageErr;
              }

              const requestHash = computeUploadRequestHash({
                userId: user.id,
                spaceId,
                path: targetPath,
                overwrite,
                expectedEtag: cleanIfMatch,
                contentSha256: stageRes.sha256,
              });

              const journalId = `jrn_${randomUUID().replace(/-/g, "")}`;
              const rollbackToken = overwrite ? `.${targetPath.split("/").pop() || "file"}.${journalId.slice(4, 20)}.rollback.tmp` : undefined;

              // Check operation idempotency
              if (db) {
                const idempRow = db.prepare(
                  `SELECT target_id, request_hash, response_payload
                   FROM operation_idempotency
                   WHERE user_id = ? AND scope = 'file_upload' AND idempotency_key = ?
                   LIMIT 1`
                ).get(user.id, idempotencyKey) as { target_id: string; request_hash: string; response_payload: string } | undefined;

                if (idempRow) {
                  await fileService.abortStage(user.id, spaceId, { path: targetPath, stageToken: stageRes.stageToken });
                  stageToken = undefined;

                  if (idempRow.request_hash === requestHash && idempRow.target_id === `${spaceId}:${targetPath}`) {
                    const storedResponse = JSON.parse(idempRow.response_payload);
                    if (isRecord(storedResponse) && storedResponse.uploaded === true && Array.isArray(storedResponse.files)) {
                      sendJsonResponse(res, 201, createSuccessEnvelope({
                        uploaded: true,
                        files: storedResponse.files,
                        count: storedResponse.count ?? 1,
                        totalBytes: storedResponse.totalBytes ?? stageRes.size,
                        idempotencyKey,
                        etag: storedResponse.etag ?? stageRes.etag,
                        isIdempotentHit: true,
                      }), {
                        "ETag": storedResponse.etag || (storedResponse.files?.[0]?.etag ?? ""),
                      });
                      return;
                    }
                  }

                  throw new PlatformError("Idempotency key reused with different upload request parameters", "IDEMPOTENCY_CONFLICT", 409);
                }

                const preResponseData = JSON.stringify({
                  uploaded: true,
                  files: [{
                    filename: targetPath.split("/").pop() || targetPath,
                    path: targetPath,
                    size: stageRes.size,
                    etag: stageRes.etag,
                    mtimeMs: 0,
                  }],
                  count: 1,
                  totalBytes: stageRes.size,
                  idempotencyKey,
                  etag: stageRes.etag,
                });

                // Record staged journal record BEFORE physical commit
                db.prepare(`
                  INSERT INTO file_transfer_journal (
                    id, user_id, space_id, relative_path, stage_token, rollback_token, overwrite, expected_etag, content_sha256, size, idempotency_key, status, response_payload, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(
                  journalId,
                  user.id,
                  spaceId,
                  targetPath,
                  stageRes.stageToken,
                  rollbackToken || null,
                  overwrite ? 1 : 0,
                  cleanIfMatch || null,
                  stageRes.sha256,
                  stageRes.size,
                  idempotencyKey,
                  preResponseData
                );
              }

              // Phase 2: Commit stage atomically
              let writeRes: CanonicalWriteResult & { rollbackToken?: string };
              try {
                writeRes = await fileService.commitStage(
                  user.id,
                  spaceId,
                  {
                    path: targetPath,
                    stageToken: stageRes.stageToken,
                    rollbackToken,
                    expectedEtag: cleanIfMatch,
                    requireAbsent: !overwrite ? true : undefined,
                  }
                );
                stageToken = undefined;
              } catch (commitErr: unknown) {
                if (stageToken) {
                  try {
                    await fileService.abortStage(user.id, spaceId, { path: targetPath, stageToken });
                  } catch (abortErr: unknown) {
                    // Abort failed
                  }
                }
                throw commitErr;
              }

              const etagHeader = writeRes.etag.startsWith('"') ? writeRes.etag : `"${writeRes.etag}"`;
              const responseData = {
                uploaded: true,
                files: [{
                  filename: targetPath.split("/").pop() || targetPath,
                  path: targetPath,
                  size: writeRes.size,
                  etag: etagHeader,
                  mtimeMs: writeRes.mtimeMs,
                }],
                count: 1,
                totalBytes: writeRes.size,
                idempotencyKey,
                etag: etagHeader,
              };

              // Immediately CAS update journal to committed state with real response payload
              if (db) {
                let committedUpdated = false;
                let commitUpdateErr: unknown;
                try {
                  const casRes = db.prepare(`
                    UPDATE file_transfer_journal
                    SET status = 'committed', rollback_token = ?, response_payload = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'staged'
                  `).run(
                    writeRes.rollbackToken || null,
                    JSON.stringify(responseData),
                    journalId
                  );
                  committedUpdated = casRes.changes === 1;
                } catch (cErr: unknown) {
                  commitUpdateErr = cErr;
                  committedUpdated = false;
                }

                if (!committedUpdated) {
                  const rollbackErrors: unknown[] = [];
                  if (commitUpdateErr) {
                    rollbackErrors.push(commitUpdateErr);
                  }

                  try {
                    await fileService.rollbackCommit(user.id, spaceId, {
                      path: targetPath,
                      rollbackToken: writeRes.rollbackToken,
                      expectedEtag: writeRes.etag,
                    });
                  } catch (rbErr: unknown) {
                    rollbackErrors.push(rbErr);
                  }

                  try {
                    db.prepare(`
                      UPDATE file_transfer_journal
                      SET status = 'rolled_back', updated_at = CURRENT_TIMESTAMP
                      WHERE id = ?
                    `).run(journalId);
                  } catch (rbDbErr: unknown) {
                    rollbackErrors.push(rbDbErr);
                  }

                  if (rollbackErrors.length > 0) {
                    const primary = commitUpdateErr instanceof Error ? commitUpdateErr : new Error('Failed to record committed stage status in journal');
                    throw new PlatformError(
                      `Failed to record committed state and rollback encountered error: ${primary.message}`,
                      'SERVICE_UNAVAILABLE',
                      503
                    );
                  }

                  throw new PlatformError('Failed to record committed stage status in journal', 'SERVICE_UNAVAILABLE', 503);
                }
              }

              // Phase 3: Atomic DB Finalization (Idempotency + Audit Log + Journal)
              if (db) {
                let startedTx = false;
                try {
                  db.exec("BEGIN IMMEDIATE");
                  startedTx = true;

                  db.prepare(`
                    UPDATE file_transfer_journal
                    SET status = 'finalized', rollback_token = ?, response_payload = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status IN ('committed', 'staged')
                  `).run(
                    writeRes.rollbackToken || null,
                    JSON.stringify(responseData),
                    journalId
                  );

                  db.prepare(`
                    INSERT INTO operation_idempotency (
                      id, user_id, scope, idempotency_key, target_id, request_hash, response_payload, created_at
                    ) VALUES (?, ?, 'file_upload', ?, ?, ?, ?, CURRENT_TIMESTAMP)
                  `).run(
                    `idemp_${randomUUID().replace(/-/g, "")}`,
                    user.id,
                    idempotencyKey,
                    `${spaceId}:${targetPath}`,
                    requestHash,
                    JSON.stringify(responseData)
                  );

                  db.prepare(`
                    INSERT INTO auth_audit_log (
                      id, user_id, username, action, ip_address, user_agent, details, created_at
                    ) VALUES (?, ?, ?, 'file_uploaded', ?, ?, ?, CURRENT_TIMESTAMP)
                  `).run(
                    `audit_${randomUUID().replace(/-/g, "")}`,
                    user.id,
                    user.username || user.id,
                    clientIp,
                    req.headers["user-agent"] ?? null,
                    JSON.stringify({
                      resourceType: "file",
                      spaceId,
                      path: targetPath,
                      size: writeRes.size,
                      etag: writeRes.etag,
                    })
                  );

                  db.exec("COMMIT");
                  startedTx = false;

                  // Finalize stage backup
                  if (writeRes.rollbackToken) {
                    try {
                      await fileService.finalizeStage(user.id, spaceId, {
                        path: targetPath,
                        rollbackToken: writeRes.rollbackToken,
                      });
                    } catch (finErr: unknown) {
                      try {
                        db.prepare(`
                          UPDATE file_transfer_journal
                          SET status = 'cleanup_pending', updated_at = CURRENT_TIMESTAMP
                          WHERE id = ?
                        `).run(journalId);
                      } catch (cpErr: unknown) {
                        // Cleanup pending record
                      }
                    }
                  }
                } catch (dbErr: unknown) {
                  const cleanupErrors: unknown[] = [dbErr];
                  if (startedTx) {
                    try {
                      db.exec("ROLLBACK");
                    } catch (rbErr: unknown) {
                      cleanupErrors.push(rbErr);
                    }
                  }

                  // Compensation rollback of physical file
                  try {
                    await fileService.rollbackCommit(user.id, spaceId, {
                      path: targetPath,
                      rollbackToken: writeRes.rollbackToken,
                      expectedEtag: writeRes.etag,
                    });
                  } catch (fileRbErr: unknown) {
                    cleanupErrors.push(fileRbErr);
                  }

                  try {
                    db.prepare(`
                      UPDATE file_transfer_journal
                      SET status = 'rolled_back', updated_at = CURRENT_TIMESTAMP
                      WHERE id = ?
                    `).run(journalId);
                  } catch (rbJournalErr: unknown) {
                    cleanupErrors.push(rbJournalErr);
                  }

                  const primary = dbErr instanceof Error ? dbErr : new Error(String(dbErr));
                  if (cleanupErrors.length > 1) {
                    const agg = new AggregateError(cleanupErrors, `Failed to finalize file upload transaction: ${primary.message}`);
                    throw new PlatformError(agg.message, "SERVICE_UNAVAILABLE", 503);
                  }
                  throw new PlatformError(`Failed to finalize file upload transaction: ${primary.message}`, "SERVICE_UNAVAILABLE", 503);
                }
              }

              sendJsonResponse(res, 201, createSuccessEnvelope(responseData), {
                "ETag": etagHeader,
              });
              return;
            }
          }

          if (fileSub === "/rename") {
            throw new NotFoundError("Endpoint POST /api/spaces/:spaceId/files/rename has been removed");
          }
        }
      }

      // 6. Sessions Routes (/api/sessions)
      if (pathname === "/api/sessions") {
        const user = await getRequiredAuthUser(req);

        if (method === "GET") {
          const incArchivedRaw = parsedUrl.searchParams.get("includeArchived");
          let includeArchived = false;
          if (incArchivedRaw !== null) {
            if (incArchivedRaw === "true") includeArchived = true;
            else if (incArchivedRaw === "false") includeArchived = false;
            else throw new ValidationError('Invalid "includeArchived" query parameter');
          }
          const spaceIdParam = parsedUrl.searchParams.get("spaceId");
          const spaceId = spaceIdParam ? validatePathId(spaceIdParam, "spaceId") : undefined;

          const sessions = await platformApi.listSessions(user.id, { spaceId, includeArchived });
          sendJsonResponse(res, 200, createSuccessEnvelope(sessions));
          return;
        }

        if (method === "POST") {
          validateCsrf(req, { csrfToken });
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_CREATE_SESSION_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          if (typeof body.spaceId !== "string" || !body.spaceId.trim()) {
            throw new ValidationError('Field "spaceId" is required');
          }
          const spaceId = validatePathId(body.spaceId, "spaceId");
          const title = body.title !== undefined ? validateResourceName(body.title, "title") : "New Session";

          const space = await platformApi.getSpace(user.id, spaceId);
          if (!space) {
            throw new NotFoundError(`Space "${spaceId}" not found`);
          }

          if (body.executionMode !== undefined) {
            if (body.executionMode !== "container" && body.executionMode !== "host") {
              throw new ValidationError('Invalid executionMode: Expected container or host');
            }
            if (body.executionMode !== space.executionMode) {
              throw new ValidationError('Session executionMode cannot override or mismatch space executionMode');
            }
          }

          const session = await platformApi.createSession(user.id, {
            spaceId,
            title,
            executionMode: space.executionMode,
          });
          sendJsonResponse(res, 201, createSuccessEnvelope(session));
          return;
        }
      }

      // 6.1 Session Sub-resources: /api/sessions/:sessionId/*
      const sessionSubMatch = pathname.match(/^\/api\/sessions\/([^/]+)(.*)$/);
      if (sessionSubMatch) {
        const user = await getRequiredAuthUser(req);
        const sessionId = validatePathId(sessionSubMatch[1], "sessionId");
        const subPath = sessionSubMatch[2];

        // 6.1.1 /api/sessions/:sessionId
        if (subPath === "" || subPath === "/") {
          if (method === "GET") {
            const session = await platformApi.getSession(user.id, sessionId);
            if (!session) {
              throw new NotFoundError(`Session "${sessionId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(session));
            return;
          }

          if (method === "PATCH") {
            validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, ALLOWED_UPDATE_SESSION_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }
            const title = validateResourceName(body.title, "title");
            const updated = await platformApi.updateSession(user.id, sessionId, { title });
            if (!updated) {
              throw new NotFoundError(`Session "${sessionId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(updated));
            return;
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
              const session = await platformApi.getSession(user.id, sessionId);
            if (!session) {
              throw new NotFoundError(`Session "${sessionId}" not found`);
            }
            const archived = await platformApi.archiveSession(user.id, sessionId);
            sendJsonResponse(res, 200, createSuccessEnvelope(archived));
            return;
          }
        }

        // 6.1.2 /api/sessions/:sessionId/archive
        if (subPath === "/archive") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await readBody(req, maxBodyBytes);
          if (rawBody.trim().length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              throw new ValidationError("Malformed JSON body");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
              throw new ValidationError("Archive request body must be empty or empty object");
            }
          }
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          const archived = await platformApi.archiveSession(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope(archived));
          return;
        }

        // 6.1.2b /api/sessions/:sessionId/restore
        if (subPath === "/restore") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await readBody(req, maxBodyBytes);
          if (rawBody.trim().length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              throw new ValidationError("Malformed JSON body");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
              throw new ValidationError("Restore request body must be empty or empty object");
            }
          }
          const restored = await platformApi.restoreSession(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope(restored));
          return;
        }

        // 6.1.2c /api/sessions/:sessionId/fork
        if (subPath === "/fork") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          let idempotencyKey: string | undefined = undefined;
          if (req.headers["x-idempotency-key"] !== undefined) {
            throw new ValidationError('Alternate header "x-idempotency-key" is not permitted. Use canonical "Idempotency-Key" header');
          }
          const rawIdemp = req.headers["idempotency-key"];
          if (rawIdemp !== undefined && rawIdemp !== null && (typeof rawIdemp !== "string" || rawIdemp.length > 0)) {
            if (Array.isArray(rawIdemp) || (typeof rawIdemp === "string" && rawIdemp.includes(","))) {
              throw new ValidationError("Duplicate or comma-separated Idempotency-Key headers (arrays and comma-separated) are forbidden");
            }
            if (typeof rawIdemp !== "string" || rawIdemp !== rawIdemp.trim() || !CANONICAL_UUID_V4_REGEX.test(rawIdemp)) {
              throw new ValidationError("Invalid Idempotency-Key format. Expected exact canonical lowercase UUID v4 (canonical lowercase UUID-v4).");
            }
            idempotencyKey = rawIdemp;
          }

          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_FORK_SESSION_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          let fromMessageId: string | undefined = undefined;
          if (body.fromMessageId !== undefined && body.fromMessageId !== null) {
            if (typeof body.fromMessageId !== "string" || !body.fromMessageId.trim()) {
              throw new ValidationError('Field "fromMessageId" must be a non-empty string');
            }
            fromMessageId = body.fromMessageId.trim();
          }

          let fromTurnId: string | undefined = undefined;
          if (body.fromTurnId !== undefined && body.fromTurnId !== null) {
            if (typeof body.fromTurnId !== "string" || !body.fromTurnId.trim()) {
              throw new ValidationError('Field "fromTurnId" must be a non-empty string');
            }
            fromTurnId = body.fromTurnId.trim();
          }

          let title: string | undefined = undefined;
          if (body.title !== undefined && body.title !== null) {
            title = validateResourceName(body.title, "title");
          }

          let targetSpaceId: string | undefined = undefined;
          if (body.targetSpaceId !== undefined && body.targetSpaceId !== null) {
            targetSpaceId = validatePathId(body.targetSpaceId, "targetSpaceId");
          }

          const forkedSession = await platformApi.forkSession(user.id, sessionId, {
            fromMessageId,
            fromTurnId,
            title,
            targetSpaceId,
            idempotencyKey,
          });

          sendJsonResponse(res, 201, createSuccessEnvelope(forkedSession));
          return;
        }

        // 6.1.2d /api/sessions/:sessionId/regenerate
        if (subPath === "/regenerate") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_REGENERATE_SESSION_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          if (typeof body.sourceMessageId !== "string" || !body.sourceMessageId.trim()) {
            throw new ValidationError('Field "sourceMessageId" must be a non-empty string');
          }
          const sourceMessageId = body.sourceMessageId.trim();

          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }

          if (!db) {
            throw new PlatformError('Database unavailable', 'INTERNAL_ERROR', 500);
          }

          // Check active turn
          const activeTurns = db.prepare(`
            SELECT id FROM turn_runs
            WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
            LIMIT 1
          `).get(sessionId, user.id);
          if (activeTurns) {
            throw new PlatformError('Cannot regenerate message while a turn is active', 'TURN_ACTIVE', 409);
          }

          // Fetch messages
          const allMsgs = db.prepare(`
            SELECT id, role, content, turn_id, created_at
            FROM web_messages
            WHERE session_id = ? AND user_id = ?
            ORDER BY created_at ASC, id ASC
          `).all(sessionId, user.id) as Array<{ id: string; role: string; content: string; turn_id: string | null; created_at: string }>;

          const targetMsgIdx = allMsgs.findIndex((m) => m.id === sourceMessageId);
          if (targetMsgIdx === -1) {
            throw new NotFoundError(`Message "${sourceMessageId}" not found in session`);
          }

          const targetMsg = allMsgs[targetMsgIdx];
          let userPromptMsg: { id: string; role: string; content: string; turn_id: string | null } | undefined;
          let userPromptIdx = -1;

          if (targetMsg.role === 'assistant') {
            // Find preceding user message
            for (let i = targetMsgIdx - 1; i >= 0; i--) {
              if (allMsgs[i].role === 'user') {
                userPromptMsg = allMsgs[i];
                userPromptIdx = i;
                break;
              }
            }
            if (!userPromptMsg) {
              throw new ValidationError('Cannot regenerate assistant message without preceding user prompt');
            }
          } else {
            userPromptMsg = targetMsg;
            userPromptIdx = targetMsgIdx;
          }

          // Branch boundary is the message immediately before userPromptMsg
          let forkedSession: PublicSession;
          const targetSpaceId = body.targetSpaceId ? validatePathId(body.targetSpaceId, "targetSpaceId") : undefined;
          const branchTitle = body.title !== undefined ? validateResourceName(body.title, "title") : `${session.title || 'Session'} (Branch)`;

          if (userPromptIdx > 0) {
            const boundaryMsg = allMsgs[userPromptIdx - 1];
            forkedSession = await platformApi.forkSession(user.id, sessionId, {
              fromMessageId: boundaryMsg.id,
              title: branchTitle,
              targetSpaceId,
            });
          } else {
            // First turn in session - create new session in target space
            forkedSession = await platformApi.createSession(user.id, {
              spaceId: targetSpaceId || session.spaceId,
              title: branchTitle,
            });
          }

          // Get prompt message attachments & reply references
          const promptAtts = db.prepare(`
            SELECT relative_path, snapshot_path, etag, size, media_type, display_name
            FROM message_attachments
            WHERE message_id = ? AND user_id = ?
            ORDER BY rowid ASC
          `).all(userPromptMsg.id, user.id) as Array<{
            relative_path: string;
            snapshot_path: string;
            etag: string;
            size: number;
            media_type: string;
            display_name: string | null;
          }>;

          const promptRef = db.prepare(`
            SELECT reply_to_message_id
            FROM message_references
            WHERE message_id = ? AND user_id = ?
            LIMIT 1
          `).get(userPromptMsg.id, user.id) as { reply_to_message_id: string | null } | undefined;

          const canonicalAtts = promptAtts.map((a) => ({
            id: generate32HexId('att'),
            relativePath: a.relative_path,
            snapshotPath: a.snapshot_path,
            downloadReference: `/api/files/download?snapshot=${encodeURIComponent(a.snapshot_path)}`,
            etag: a.etag,
            size: a.size,
            mediaType: a.media_type,
            displayName: a.display_name || undefined,
          }));

          const timestamp = new Date().toISOString();
          const deliveryId = generate32HexId('deliv');
          const inboundEnvelope: InboundEnvelope = {
            id: deliveryId,
            userId: user.id,
            sessionId: forkedSession.id,
            content: userPromptMsg.content,
            timestamp,
            ...(canonicalAtts.length > 0 ? { attachments: canonicalAtts } : {}),
            ...(promptRef?.reply_to_message_id ? { replyToMessageId: promptRef.reply_to_message_id } : {}),
          };

          const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

          sendJsonResponse(res, 201, createSuccessEnvelope({
            newSessionId: forkedSession.id,
            sessionId: forkedSession.id,
            session: forkedSession,
            sourceSessionId: sessionId,
            sourceMessageId,
            message: dispatchResult.message,
            accepted: true,
          }));
          return;
        }

        // 6.1.3 /api/sessions/:sessionId/reset
        if (subPath === "/reset") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const idempotencyKey = requireIdempotencyKey(req);
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_RESET_SESSION_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          const reason = body.reason !== undefined ? validateExactTrimmed(body.reason, "reason") : "manual_reset";

          const resetResult = await platformApi.resetSession(user.id, sessionId, {
            idempotencyKey,
            reason,
          });

          sendJsonResponse(res, 200, createSuccessEnvelope({
            generation: resetResult.generation.generation,
            currentGeneration: resetResult.generation.generation,
            resetReason: resetResult.generation.resetReason,
            session: resetResult.session,
            generationRecord: resetResult.generation,
            isIdempotentHit: resetResult.isIdempotentHit,
          }));
          return;
        }

        // 6.1.4 /api/sessions/:sessionId/generations
        if (subPath === "/generations") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          const gens = await platformApi.listSessionGenerations(user.id, sessionId);
          const currentGen = gens.find((g) => g.isCurrent)?.generation ?? 1;
          sendJsonResponse(res, 200, createSuccessEnvelope({
            currentGeneration: currentGen,
            generations: gens.map((g) => ({
              generationNumber: g.generation,
              resetReason: g.resetReason,
              current: g.isCurrent,
              createdAt: g.createdAt,
            })),
          }));
          return;
        }

        // 6.1.5 /api/sessions/:sessionId/turns (Admin/User Turn Status History)
        if (subPath === "/turns") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const turns = await cds.listSessionTurns(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope({
            sessionId,
            turns,
          }));
          return;
        }

        // 6.1.6 /api/sessions/:sessionId/turn/current
        if (subPath === "/turn/current") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          const status = await runtimeGateway.getCurrentTurnStatus(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope(status));
          return;
        }

        // 6.1.7 /api/sessions/:sessionId/turn/cancel-current
        if (subPath === "/turn/cancel-current") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          const cancelled = await runtimeGateway.cancelCurrentTurn(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope({ cancelled }));
          return;
        }

        // 6.1.7b /api/sessions/:sessionId/recovery
        if (subPath === "/recovery") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          if (!sessionLifecycleService) {
            throw new PlatformError("Session recovery service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }
          const inspection = await sessionLifecycleService.inspectSessionRecovery(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope(inspection));
          return;
        }

        // 6.1.7c /api/sessions/:sessionId/recovery/fork-valid-prefix
        if (subPath === "/recovery/fork-valid-prefix") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const idempotencyKey = requireIdempotencyKey(req);
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          if (!sessionLifecycleService) {
            throw new PlatformError("Session recovery service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }
          const body = await parseJsonBody(req, maxBodyBytes);
          const replayQueued = Boolean(body?.replayQueued);
          const result = await sessionLifecycleService.recoverValidPrefix(user.id, sessionId, { replayQueued });
          sendJsonResponse(res, 200, createSuccessEnvelope(result));
          return;
        }

        // 6.1.7d /api/sessions/:sessionId/recovery/start-new-generation
        if (subPath === "/recovery/start-new-generation") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const idempotencyKey = requireIdempotencyKey(req);
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          if (!sessionLifecycleService) {
            throw new PlatformError("Session recovery service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }
          const result = await sessionLifecycleService.startNewGeneration(user.id, sessionId);
          sendJsonResponse(res, 200, createSuccessEnvelope(result));
          return;
        }

        // 6.1.8 /api/sessions/:sessionId/messages
        if (subPath === "/messages") {
          if (method === "GET") {
            for (const key of parsedUrl.searchParams.keys()) {
              if (key !== "limit" && key !== "before" && key !== "after") {
                throw new ValidationError(`Unexpected query parameter "${key}"`);
              }
            }
            const before = parsedUrl.searchParams.get("before") || undefined;
            const after = parsedUrl.searchParams.get("after") || undefined;
            if (before && after) {
              throw new ValidationError("Cannot specify both 'before' and 'after' query parameters");
            }
            const limitParam = parsedUrl.searchParams.get("limit");
            const limit = limitParam !== null ? parseLimit(limitParam) : 50;

            const session = await platformApi.getSession(user.id, sessionId);
            if (!session) {
              throw new NotFoundError(`Session "${sessionId}" not found`);
            }

            const messages = await platformApi.listMessages(user.id, sessionId, { limit, before, after });
            sendJsonResponse(res, 200, createSuccessEnvelope(messages));
            return;
          }

          if (method === "POST") {
            validateCsrf(req, { csrfToken });
              const idempotencyKey = requireIdempotencyKey(req);
            const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, ALLOWED_MESSAGE_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            validateMessageContent(body.content);
            let validatedAtts: any[] | undefined;
            if (body.attachments !== undefined) {
              validatedAtts = validateAttachments(body.attachments);
            }

            let replyToMessageId: string | undefined;
            if (body.replyToMessageId !== undefined && body.replyToMessageId !== null) {
              if (typeof body.replyToMessageId !== "string" || !body.replyToMessageId.trim()) {
                throw new ValidationError('Field "replyToMessageId" must be a non-empty string');
              }
              replyToMessageId = body.replyToMessageId.trim();
            }

            const session = await platformApi.getSession(user.id, sessionId);
            if (!session) {
              throw new NotFoundError(`Session "${sessionId}" not found`);
            }

            const timestamp = new Date().toISOString();
            const deliveryId = `deliv_${idempotencyKey.replace(/-/g, "").toLowerCase()}`;
            const inboundEnvelope: InboundEnvelope = {
              id: deliveryId,
              userId: user.id,
              sessionId,
              content: body.content as string,
              timestamp,
              ...(validatedAtts && validatedAtts.length > 0 ? { attachments: validatedAtts } : {}),
              ...(replyToMessageId ? { replyToMessageId } : {}),
            };

            const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

            const publicMessage: PublicMessage = {
              id: idempotencyKey,
              role: "user",
              content: body.content as string,
              status: "delivered",
              createdAt: timestamp,
            };

            sendJsonResponse(res, 200, createSuccessEnvelope({
              accepted: true,
              message: (dispatchResult as any).message ?? publicMessage,
              isDuplicate: Boolean((dispatchResult as any).isDuplicate),
            }));
            return;
          }
        }

        // 6.1.9 /api/sessions/:sessionId/events
        if (subPath === "/events") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }
          const cursor = parsedUrl.searchParams.get("cursor") || undefined;

          const events = await platformApi.pollEvents(user.id, sessionId, cursor);
          sendJsonResponse(res, 200, createSuccessEnvelope(events));
          return;
        }

        // 6.1.9b /api/sessions/:sessionId/model-override
        if (subPath === "/model-override") {
          const session = await platformApi.getSession(user.id, sessionId);
          if (!session) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }

          if (method === "GET") {
            const override = await modelSelectionService.getOverride("session", sessionId);
            sendJsonResponse(res, 200, createSuccessEnvelope(override));
            return;
          }

          if (method === "PUT" || method === "PATCH") {
            validateCsrf(req, { csrfToken });
            const rawHeader = req.headers["if-match"];
            if (Array.isArray(rawHeader)) {
              throw new ValidationError('Multiple or duplicate "If-Match" headers are not allowed');
            }
            const ifMatchHeader = typeof rawHeader === "string" ? rawHeader : undefined;

            const rawBody = await parseJsonBody(req, maxBodyBytes);
            if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
              throw new ValidationError("Request body cannot be empty");
            }
            const unknownKeys = getUnknownKeys(rawBody, ALLOWED_MODEL_OVERRIDE_KEYS);
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            if (typeof rawBody.provider !== "string" || !rawBody.provider.trim()) {
              throw new ValidationError('Field "provider" must be a non-empty string');
            }
            if (typeof rawBody.model !== "string" || !rawBody.model.trim()) {
              throw new ValidationError('Field "model" must be a non-empty string');
            }
            if (rawBody.reasoningEffort !== undefined && typeof rawBody.reasoningEffort !== "string" && rawBody.reasoningEffort !== null) {
              throw new ValidationError('Field "reasoningEffort" must be a string or null');
            }
            if (rawBody.fallbackChain !== undefined && !Array.isArray(rawBody.fallbackChain) && rawBody.fallbackChain !== null) {
              throw new ValidationError('Field "fallbackChain" must be an array or null');
            }

            const ifMatch = (typeof rawBody.ifMatch === "string" ? rawBody.ifMatch : undefined) ?? ifMatchHeader;

            const updated = await modelSelectionService.setOverride(
              user.id,
              "session",
              sessionId,
              {
                provider: rawBody.provider,
                model: rawBody.model,
                reasoningEffort: typeof rawBody.reasoningEffort === "string" ? rawBody.reasoningEffort : null,
                fallbackChain: Array.isArray(rawBody.fallbackChain) ? rawBody.fallbackChain : null,
                ifMatch,
              },
              user.id
            );

            sendJsonResponse(res, 200, createSuccessEnvelope(updated));
            return;
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
            const deleted = await modelSelectionService.deleteOverride("session", sessionId, user.id);
            sendJsonResponse(res, 200, createSuccessEnvelope({ deleted }));
            return;
          }

          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        // 6.1.10 /api/sessions/:sessionId/import-history removed
        if (subPath === "/import-history") {
          throw new NotFoundError("Endpoint POST /api/sessions/:sessionId/import-history has been removed");
        }

        // 6.1.11 /api/sessions/:sessionId/messages/:messageId/edit
        const sessMsgEditMatch = subPath.match(/^\/messages\/([^\/]+)\/edit$/);
        if (sessMsgEditMatch) {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const messageId = validatePathId(sessMsgEditMatch[1], "messageId");
          const body = await parseJsonBody(req, maxBodyBytes);
          const unknownKeys = getUnknownKeys(body, ALLOWED_EDIT_MESSAGE_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }

          validateMessageContent(body.content);
          let validatedAtts: any[] | undefined;
          if (body.attachments !== undefined) {
            validatedAtts = validateAttachments(body.attachments);
          }

          if (!db) {
            throw new PlatformError('Database unavailable', 'INTERNAL_ERROR', 500);
          }

          const msgRow = db.prepare(`
            SELECT id, session_id, user_id, role, content, status, turn_id, created_at
            FROM web_messages
            WHERE id = ? AND session_id = ? AND user_id = ?
            LIMIT 1
          `).get(messageId, sessionId, user.id) as { id: string; session_id: string; user_id: string; role: string; content: string; status: string; turn_id: string | null; created_at: string } | undefined;

          if (!msgRow) {
            throw new NotFoundError(`Message "${messageId}" not found`);
          }

          const sourceSession = await platformApi.getSession(user.id, sessionId);
          if (!sourceSession) {
            throw new NotFoundError(`Session "${sessionId}" not found`);
          }

          // Active turn check on source session
          const activeTurns = db.prepare(`
            SELECT id FROM turn_runs
            WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
            LIMIT 1
          `).get(sessionId, user.id);
          if (activeTurns) {
            throw new PlatformError('Cannot edit message while a turn is active', 'TURN_ACTIVE', 409);
          }

          // Fetch all messages in session
          const allMsgs = db.prepare(`
            SELECT id, role, content, turn_id, created_at
            FROM web_messages
            WHERE session_id = ? AND user_id = ?
            ORDER BY created_at ASC, id ASC
          `).all(sessionId, user.id) as Array<{ id: string; role: string; content: string; turn_id: string | null; created_at: string }>;

          const targetIdx = allMsgs.findIndex((m) => m.id === messageId);
          if (targetIdx === -1) {
            throw new NotFoundError(`Message "${messageId}" not found in session`);
          }

          const targetSpaceId = body.targetSpaceId ? validatePathId(body.targetSpaceId, "targetSpaceId") : undefined;
          const branchTitle = body.title !== undefined ? validateResourceName(body.title, "title") : `${sourceSession.title || 'Session'} (Edit)`;

          let forkedSession: PublicSession;
          if (targetIdx > 0) {
            const boundaryMsg = allMsgs[targetIdx - 1];
            forkedSession = await platformApi.forkSession(user.id, sessionId, {
              fromMessageId: boundaryMsg.id,
              title: branchTitle,
              targetSpaceId,
            });
          } else {
            forkedSession = await platformApi.createSession(user.id, {
              spaceId: targetSpaceId || sourceSession.spaceId,
              title: branchTitle,
            });
          }

          const timestamp = new Date().toISOString();
          const deliveryId = generate32HexId('deliv');
          const inboundEnvelope: InboundEnvelope = {
            id: deliveryId,
            userId: user.id,
            sessionId: forkedSession.id,
            content: body.content as string,
            timestamp,
            ...(validatedAtts && validatedAtts.length > 0 ? { attachments: validatedAtts } : {}),
            ...(body.replyToMessageId ? { replyToMessageId: String(body.replyToMessageId) } : {}),
          };

          const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

          sendJsonResponse(res, 201, createSuccessEnvelope({
            newSessionId: forkedSession.id,
            sessionId: forkedSession.id,
            session: forkedSession,
            sourceSessionId: sessionId,
            sourceMessageId: messageId,
            message: dispatchResult.message,
            accepted: true,
          }));
          return;
        }
      }

      // 6.2 Standalone Message Routes (/api/messages/:messageId/edit)
      const standaloneMsgEditMatch = pathname.match(/^\/api\/messages\/([^\/]+)\/edit$/);
      if (standaloneMsgEditMatch) {
        const user = await getRequiredAuthUser(req);
        if (method !== "POST") {
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
        validateCsrf(req, { csrfToken });
        const messageId = validatePathId(standaloneMsgEditMatch[1], "messageId");
        const body = await parseJsonBody(req, maxBodyBytes);
        const unknownKeys = getUnknownKeys(body, ALLOWED_EDIT_MESSAGE_KEYS);
        if (unknownKeys.length > 0) {
          throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
        }

        validateMessageContent(body.content);
        let validatedAtts: any[] | undefined;
        if (body.attachments !== undefined) {
          validatedAtts = validateAttachments(body.attachments);
        }

        if (!db) {
          throw new PlatformError('Database unavailable', 'INTERNAL_ERROR', 500);
        }

        const msgRow = db.prepare(`
          SELECT id, session_id, user_id, role, content, status, turn_id, created_at
          FROM web_messages
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `).get(messageId, user.id) as { id: string; session_id: string; user_id: string; role: string; content: string; status: string; turn_id: string | null; created_at: string } | undefined;

        if (!msgRow) {
          throw new NotFoundError(`Message "${messageId}" not found`);
        }

        const sourceSessionId = msgRow.session_id;
        const sourceSession = await platformApi.getSession(user.id, sourceSessionId);
        if (!sourceSession) {
          throw new NotFoundError(`Session "${sourceSessionId}" not found`);
        }

        // Active turn check on source session
        const activeTurns = db.prepare(`
          SELECT id FROM turn_runs
          WHERE route_id = ? AND user_id = ? AND status IN ('running', 'queued')
          LIMIT 1
        `).get(sourceSessionId, user.id);
        if (activeTurns) {
          throw new PlatformError('Cannot edit message while a turn is active', 'TURN_ACTIVE', 409);
        }

        // Fetch all messages in session
        const allMsgs = db.prepare(`
          SELECT id, role, content, turn_id, created_at
          FROM web_messages
          WHERE session_id = ? AND user_id = ?
          ORDER BY created_at ASC, id ASC
        `).all(sourceSessionId, user.id) as Array<{ id: string; role: string; content: string; turn_id: string | null; created_at: string }>;

        const targetIdx = allMsgs.findIndex((m) => m.id === messageId);
        if (targetIdx === -1) {
          throw new NotFoundError(`Message "${messageId}" not found in session`);
        }

        const targetSpaceId = body.targetSpaceId ? validatePathId(body.targetSpaceId, "targetSpaceId") : undefined;
        const branchTitle = body.title !== undefined ? validateResourceName(body.title, "title") : `${sourceSession.title || 'Session'} (Edit)`;

        let forkedSession: PublicSession;
        if (targetIdx > 0) {
          const boundaryMsg = allMsgs[targetIdx - 1];
          forkedSession = await platformApi.forkSession(user.id, sourceSessionId, {
            fromMessageId: boundaryMsg.id,
            title: branchTitle,
            targetSpaceId,
          });
        } else {
          forkedSession = await platformApi.createSession(user.id, {
            spaceId: targetSpaceId || sourceSession.spaceId,
            title: branchTitle,
          });
        }

        const timestamp = new Date().toISOString();
        const deliveryId = generate32HexId('deliv');
        const inboundEnvelope: InboundEnvelope = {
          id: deliveryId,
          userId: user.id,
          sessionId: forkedSession.id,
          content: body.content as string,
          timestamp,
          ...(validatedAtts && validatedAtts.length > 0 ? { attachments: validatedAtts } : {}),
          ...(body.replyToMessageId ? { replyToMessageId: String(body.replyToMessageId) } : {}),
        };

        const dispatchResult = await runtimeGateway.dispatchInbound(inboundEnvelope);

        sendJsonResponse(res, 201, createSuccessEnvelope({
          newSessionId: forkedSession.id,
          sessionId: forkedSession.id,
          session: forkedSession,
          sourceSessionId,
          sourceMessageId: messageId,
          message: dispatchResult.message,
          accepted: true,
        }));
        return;
      }

      // 6.5 Model Resolution & Inspection Routes (/api/models/*)
      if (pathname === "/api/models" || pathname.startsWith("/api/models/")) {
        const user = await getRequiredAuthUser(req, { allowMustChangePassword: true });
        const sub = pathname.slice("/api/models".length);

        if (sub === "" || sub === "/") {
          if (method === "GET") {
            const catalog = modelSelectionService.getDshCatalog();
            const summaries = await modelSelectionService.getHealthSummaries();
            sendJsonResponse(res, 200, createSuccessEnvelope({
              providers: catalog.providers,
              defaultModel: catalog.defaultModel,
              healthSummaries: summaries,
            }));
            return;
          }
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        if (sub === "/effective") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const spaceIdParam = parsedUrl.searchParams.get("spaceId") || undefined;
          const sessionIdParam = parsedUrl.searchParams.get("sessionId") || undefined;

          if (spaceIdParam) {
            validatePathId(spaceIdParam, "spaceId");
            const space = await platformApi.getSpace(user.id, spaceIdParam);
            if (!space && user.role !== "admin") {
              throw new NotFoundError(`Space "${spaceIdParam}" not found`);
            }
          }

          if (sessionIdParam) {
            validatePathId(sessionIdParam, "sessionId");
            const session = await platformApi.getSession(user.id, sessionIdParam);
            if (!session && user.role !== "admin") {
              throw new NotFoundError(`Session "${sessionIdParam}" not found`);
            }
          }

          const effective = await modelSelectionService.resolveEffectiveModel({
            sessionId: sessionIdParam,
            spaceId: spaceIdParam,
            userId: user.id,
          });

          sendJsonResponse(res, 200, createSuccessEnvelope(effective));
          return;
        }

        if (sub === "/overrides") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const overrides = await modelSelectionService.listOverridesForUser(user.id);
          sendJsonResponse(res, 200, createSuccessEnvelope(overrides));
          return;
        }
      }

      // 6.6 Interactions & Approvals API (/api/interactions/approvals/*)
      if (pathname === "/api/interactions/approvals" || pathname.startsWith("/api/interactions/approvals/")) {
        const user = await getRequiredAuthUser(req);
        const sub = pathname.slice("/api/interactions/approvals".length);

        if (sub === "" || sub === "/") {
          if (method === "GET") {
            const sessionIdParam = parsedUrl.searchParams.get("sessionId") || undefined;
            if (sessionIdParam) {
              validatePathId(sessionIdParam, "sessionId");
              const session = await platformApi.getSession(user.id, sessionIdParam);
              if (!session && user.role !== "admin") {
                throw new NotFoundError(`Session "${sessionIdParam}" not found`);
              }
            }

            const rawApprovals = externalInteractionService
              ? externalInteractionService.listPendingApprovals({
                  userId: user.role === "admin" ? undefined : user.id,
                  sessionId: sessionIdParam,
                })
              : [];

            sendJsonResponse(res, 200, createSuccessEnvelope(rawApprovals));
            return;
          }
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        // Subpath: /api/interactions/approvals/:approvalId or /api/interactions/approvals/:approvalId/decide or /cancel
        const segments = sub.slice(1).split("/");
        const approvalId = segments[0];
        if (!approvalId) {
          throw new ValidationError("Approval ID is required");
        }

        const approval = externalInteractionService ? externalInteractionService.getPendingApproval(approvalId) : undefined;
        if (!approval) {
          throw new NotFoundError(`Approval "${approvalId}" not found`);
        }

        // Verify tenant ownership
        if (user.role !== "admin" && approval.userId && approval.userId !== user.id) {
          throw new NotFoundError(`Approval "${approvalId}" not found`);
        }

        if (segments.length === 1) {
          if (method === "GET") {
            sendJsonResponse(res, 200, createSuccessEnvelope(approval));
            return;
          }
          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        if (segments.length === 2 && segments[1] === "decide") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const body = await parseJsonBody(req, maxBodyBytes);
          const outcome = body.outcome;
          if (outcome !== "allowed-once" && outcome !== "rejected") {
            throw new ValidationError('Field "outcome" must be "allowed-once" or "rejected"');
          }

          const decided = externalInteractionService ? externalInteractionService.answerApproval(approvalId, outcome) : false;
          sendJsonResponse(res, 200, createSuccessEnvelope({
            id: approvalId,
            status: outcome,
            decided: Boolean(decided),
          }));
          return;
        }

        if (segments.length === 2 && segments[1] === "cancel") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const body = await parseJsonBody(req, maxBodyBytes);
          const reason = typeof body.reason === "string" ? body.reason : undefined;

          const cancelled = externalInteractionService ? externalInteractionService.cancelApproval(approvalId, reason) : false;
          sendJsonResponse(res, 200, createSuccessEnvelope({
            id: approvalId,
            status: "cancelled",
            cancelled: Boolean(cancelled),
          }));
          return;
        }

        throw new NotFoundError(`Endpoint "${pathname}" not found`);
      }

      // 7. Manage Routes (/api/manage/*)
      if (pathname.startsWith("/api/manage/")) {
        const user = await getRequiredAuthUser(req);
        if (extensionRoutes && pathname.startsWith("/api/manage/extensions")) {
          const handled = await extensionRoutes.handle(req, res, pathname, user);
          if (handled) return;
        }
        if (channelRoutes && pathname.startsWith("/api/manage/channels")) {
          const handled = await channelRoutes.handle(req, res, pathname, user);
          if (handled) return;
        }
        const managePath = pathname.slice("/api/manage/".length);

        // 7.1 Overview: GET /api/manage/overview
        if (managePath === "overview") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const counts = await cds.getUserOverview(user.id);
          let userRuntime: UserRuntimeStatus | null = null;
          if (managementProvider) {
            try {
              const rt = await managementProvider.getUserRuntime(user.id);
              userRuntime = rt ? validateUserRuntimeStatus(rt) : null;
            } catch {
              userRuntime = null;
            }
          }
          sendJsonResponse(res, 200, createSuccessEnvelope({
            user: {
              id: user.id,
              username: user.username,
              role: user.role,
              status: user.status,
              displayName: user.displayName,
            },
            counts,
            runtime: userRuntime,
          }));
          return;
        }

        // 7.2 Tasks: /api/manage/tasks*
        if (managePath === "tasks" || managePath.startsWith("tasks/")) {
          const taskSub = managePath === "tasks" ? "" : managePath.slice("tasks/".length);

          if (taskSub === "") {
            if (method === "GET") {
              const statusParam = parsedUrl.searchParams.get("status");
              const priorityParam = parsedUrl.searchParams.get("priority");
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");

              if (statusParam !== null && !VALID_TASK_STATUSES.has(statusParam)) {
                throw new ValidationError("Invalid task status filter");
              }
              if (priorityParam !== null && !VALID_TASK_PRIORITIES.has(priorityParam)) {
                throw new ValidationError("Invalid task priority filter");
              }
              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const tasks = await cds.listTasks({
                userId: user.id,
                status: statusParam as any || undefined,
                priority: priorityParam as any || undefined,
                limit,
                offset,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope(tasks));
              return;
            }

            if (method === "POST") {
              validateCsrf(req, { csrfToken });
                  const idempotencyKey = requireIdempotencyKey(req);
              if (!operations) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }

              const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, ALLOWED_CREATE_TASK_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }

              if (body.prompt === undefined || body.prompt === null) {
                throw new ValidationError('Task prompt is required');
              }
              if (typeof body.prompt !== "string" || !body.prompt.trim()) {
                throw new ValidationError('Task prompt must be a non-empty string under 64 KiB');
              }
              if (Buffer.byteLength(body.prompt, "utf8") > 65536) {
                throw new ValidationError('Task prompt exceeds maximum limit of 64 KiB');
              }
              if (body.sessionId === undefined || body.sessionId === null) {
                throw new ValidationError('Task sessionId is required');
              }
              if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
                throw new ValidationError('Task sessionId is required');
              }
              const sessionId = validatePathId(body.sessionId, "sessionId");
              const session = await platformApi.getSession(user.id, sessionId);
              if (!session) {
                throw new NotFoundError(`Session "${sessionId}" not found`);
              }

              const payload = {
                type: "agent_prompt" as const,
                prompt: body.prompt as string,
                sessionId,
                sessionPolicy: "existing_session" as const,
              };

              let validatedMisfirePolicy: 'coalesce' | 'skip' | undefined;
              if (body.misfirePolicy !== undefined && body.misfirePolicy !== null) {
                if (body.misfirePolicy !== 'coalesce' && body.misfirePolicy !== 'skip') {
                  throw new ValidationError(`Invalid misfirePolicy "${String(body.misfirePolicy)}". Expected "coalesce" or "skip"`);
                }
                validatedMisfirePolicy = body.misfirePolicy as 'coalesce' | 'skip';
              }

              let validatedOverlapPolicy: 'skip' | undefined;
              if (body.overlapPolicy !== undefined && body.overlapPolicy !== null) {
                if (body.overlapPolicy !== 'skip') {
                  throw new ValidationError(`Invalid overlapPolicy "${String(body.overlapPolicy)}". Expected "skip"`);
                }
                validatedOverlapPolicy = body.overlapPolicy as 'skip';
              }

              let validatedTimezone: string | undefined;
              if (body.timezone !== undefined && body.timezone !== null) {
                if (body.timezone !== 'UTC') {
                  throw new ValidationError(`Invalid timezone "${String(body.timezone)}". Only "UTC" is currently supported`);
                }
                validatedTimezone = 'UTC';
              }

              const result = opsProvider
                ? await opsProvider.createTask(user.id, {
                    title: body.title as string,
                    dueDate: body.dueDate as string,
                    priority: body.priority as TaskPriority,
                    scheduleType: body.scheduleType as any,
                    cronExpression: body.cronExpression as string,
                    intervalSeconds: body.intervalSeconds as number,
                    timezone: validatedTimezone,
                    misfirePolicy: validatedMisfirePolicy,
                    overlapPolicy: validatedOverlapPolicy,
                    idempotencyKey,
                    payload,
                  })
                : await operations.forTenant(user.id).tasks.createTask({
                    title: body.title as string,
                    dueDate: body.dueDate as string,
                    priority: body.priority as TaskPriority,
                    scheduleType: body.scheduleType as any,
                    cronExpression: body.cronExpression as string,
                    intervalSeconds: body.intervalSeconds as number,
                    timezone: validatedTimezone,
                    misfirePolicy: validatedMisfirePolicy,
                    overlapPolicy: validatedOverlapPolicy,
                    idempotencyKey,
                    payload,
                  });
              sendJsonResponse(res, 201, createSuccessEnvelope({
                id: result.task.id,
                status: result.task.status,
                task: result.task,
                isIdempotentHit: result.isIdempotentHit,
              }));
              return;
            }
          }

          if (taskSub === "worker/diagnostics") {
            if (user.role !== "admin") {
              throw new ForbiddenError("Administrative access required");
            }
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            if (!taskWorker) {
              throw new PlatformError("Task worker is unavailable", "SERVICE_UNAVAILABLE", 503);
            }
            const diag = await taskWorker.getDiagnostics();
            sendJsonResponse(res, 200, createSuccessEnvelope(diag));
            return;
          }

          const taskIdMatch = taskSub.match(/^([^/]+)(.*)$/);
          if (taskIdMatch) {
            const taskId = validatePathId(taskIdMatch[1], "taskId");
            const action = taskIdMatch[2];

            if (action === "" || action === "/") {
              if (method === "GET") {
                if (!operations) {
                  throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
                }
                const task = opsProvider
                  ? await opsProvider.getTask(user.id, taskId)
                  : await operations.forTenant(user.id).tasks.getTask(taskId);
                if (!task) {
                  throw new NotFoundError(`Task "${taskId}" not found`);
                }
                sendJsonResponse(res, 200, createSuccessEnvelope(task));
                return;
              }
            }

            if (action === "/cancel") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
                  if (!operations) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }
              const existing = opsProvider
                ? await opsProvider.getTask(user.id, taskId)
                : await operations.forTenant(user.id).tasks.getTask(taskId);
              if (!existing) {
                throw new NotFoundError(`Task "${taskId}" not found`);
              }
              const cancelled = opsProvider
                ? await opsProvider.cancelTask(user.id, taskId)
                : await operations.forTenant(user.id).tasks.cancelTask(taskId);
              if (taskNotificationService) {
                try {
                  await taskNotificationService.notifyTaskEvent({
                    taskId: cancelled.id,
                    userId: user.id,
                    event: "cancelled",
                    task: {
                      id: cancelled.id,
                      name: (cancelled as any).title ?? (cancelled as any).name,
                      status: cancelled.status,
                      scheduleType: cancelled.scheduleType,
                      scheduledFor: cancelled.nextRunAt ?? cancelled.dueDate ?? null,
                      startedAt: null,
                      completedAt: cancelled.completedAt ?? null,
                    },
                    run: null,
                  });
                } catch {}
              }
              sendJsonResponse(res, 200, createSuccessEnvelope({
                id: cancelled.id,
                status: cancelled.status,
                cancelled: true,
                task: cancelled,
              }));
              return;
            }

            if (action === "/run") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
                  if (!opsProvider || !taskWorker) {
                throw new PlatformError("Task worker is unavailable", "SERVICE_UNAVAILABLE", 503);
              }
              const task = await opsProvider.getTask(user.id, taskId);
              if (!task) {
                throw new NotFoundError(`Task "${taskId}" not found`);
              }
              const runResult = await (taskWorker.runNow as any)({ taskId, tenantId: user.id }) ?? await (taskWorker.runNow as any)(taskId);
              const runStatus = (runResult && typeof runResult === 'object' && 'status' in runResult) ? (runResult as any).status : 'completed';
              const runRes = (runResult && typeof runResult === 'object' && 'result' in runResult) ? (runResult as any).result : null;
              const updatedTask = await opsProvider.getTask(user.id, taskId);
              sendJsonResponse(res, 200, createSuccessEnvelope({
                taskId,
                status: runStatus,
                result: runRes,
                task: updatedTask ? { ...updatedTask, status: runStatus } : { ...task, status: runStatus },
              }));
              return;
            }

            if (action === "/pause") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              if (!operations && !opsProvider) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }
              const existing = opsProvider
                ? await opsProvider.getTask(user.id, taskId)
                : (operations ? await (operations as PlatformOperationsService).forTenant(user.id).tasks.getTask(taskId) : null);
              if (!existing) {
                throw new NotFoundError(`Task "${taskId}" not found`);
              }
              const paused = opsProvider && opsProvider.pauseTask
                ? await opsProvider.pauseTask(user.id, taskId)
                : (operations ? await (operations as PlatformOperationsService).forTenant(user.id).tasks.pauseTask(taskId) : null);
              if (!paused) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }
              sendJsonResponse(res, 200, createSuccessEnvelope({
                id: paused.id,
                status: paused.status,
                paused: true,
                task: paused,
              }));
              return;
            }

            if (action === "/resume") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              if (!operations && !opsProvider) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }
              const existing = opsProvider
                ? await opsProvider.getTask(user.id, taskId)
                : (operations ? await (operations as PlatformOperationsService).forTenant(user.id).tasks.getTask(taskId) : null);
              if (!existing) {
                throw new NotFoundError(`Task "${taskId}" not found`);
              }
              const resumed = opsProvider && opsProvider.resumeTask
                ? await opsProvider.resumeTask(user.id, taskId)
                : (operations ? await (operations as PlatformOperationsService).forTenant(user.id).tasks.resumeTask(taskId) : null);
              if (!resumed) {
                throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
              }
              sendJsonResponse(res, 200, createSuccessEnvelope({
                id: resumed.id,
                status: resumed.status,
                resumed: true,
                task: resumed,
              }));
              return;
            }

            if (action === "/runs") {
              if (method !== "GET") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              const statusParam = parsedUrl.searchParams.get("status");
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");

              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const runs = await cds.listTaskRuns({
                taskId,
                userId: user.id,
                status: statusParam || undefined,
                limit,
                offset,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope(runs));
              return;
            }

            // Task Notifications: Subscriptions
            if (action === "/notifications/subscriptions") {
              if (method === "GET") {
                const subs = await taskNotificationService.listSubscriptions(taskId, user.id);
                sendJsonResponse(res, 200, createSuccessEnvelope(subs));
                return;
              }

              if (method === "POST") {
                validateCsrf(req, { csrfToken });
                const body = await parseJsonBody(req, maxBodyBytes);
                const unknownKeys = getUnknownKeys(body, ALLOWED_CREATE_SUBSCRIPTION_KEYS);
                if (unknownKeys.length > 0) {
                  throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                }

                if (!body.channel || typeof body.channel !== "string" || !VALID_NOTIFICATION_CHANNELS.has(body.channel)) {
                  throw new ValidationError('Field "channel" must be either "in_app" or "webhook"');
                }

                const channel = body.channel as "in_app" | "webhook";
                let destination: string | null = null;
                if (channel === "webhook") {
                  if (!body.destination || typeof body.destination !== "string" || !body.destination.trim()) {
                    throw new ValidationError('Webhook subscription requires a non-empty "destination" URL');
                  }
                  destination = body.destination.trim();
                }

                let secret: string | null = null;
                if (body.secret !== undefined && body.secret !== null) {
                  if (typeof body.secret !== "string") {
                    throw new ValidationError('Field "secret" must be a string');
                  }
                  secret = body.secret;
                }

                let events: ("completed" | "failed" | "cancelled" | "timeout" | "started")[] | undefined;
                if (body.events !== undefined && body.events !== null) {
                  if (!Array.isArray(body.events)) {
                    throw new ValidationError('Field "events" must be an array of event names');
                  }
                  for (const ev of body.events) {
                    if (typeof ev !== "string" || !VALID_NOTIFICATION_EVENTS.has(ev)) {
                      throw new ValidationError(`Invalid event name "${String(ev)}"`);
                    }
                  }
                  events = body.events as ("completed" | "failed" | "cancelled" | "timeout" | "started")[];
                }

                const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;

                try {
                  const created = await taskNotificationService.createSubscription({
                    taskId,
                    userId: user.id,
                    channel,
                    destination,
                    secret,
                    events,
                    enabled,
                  });
                  sendJsonResponse(res, 201, createSuccessEnvelope(created));
                  return;
                } catch (err: unknown) {
                  if (err instanceof WebhookSecurityError) {
                    throw new ValidationError(`Webhook destination rejected: ${err.message}`);
                  }
                  throw err;
                }
              }

              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }

            if (action.startsWith("/notifications/subscriptions/")) {
              const subId = validatePathId(action.slice("/notifications/subscriptions/".length), "subscriptionId");

              if (method === "PATCH") {
                validateCsrf(req, { csrfToken });
                const body = await parseJsonBody(req, maxBodyBytes);
                const unknownKeys = getUnknownKeys(body, ALLOWED_UPDATE_SUBSCRIPTION_KEYS);
                if (unknownKeys.length > 0) {
                  throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                }

                let destination: string | null | undefined;
                if (body.destination !== undefined) {
                  destination = body.destination ? String(body.destination).trim() : null;
                }

                let secret: string | null | undefined;
                if (body.secret !== undefined) {
                  secret = body.secret ? String(body.secret) : null;
                }

                let events: ("completed" | "failed" | "cancelled" | "timeout" | "started")[] | undefined;
                if (body.events !== undefined && body.events !== null) {
                  if (!Array.isArray(body.events)) {
                    throw new ValidationError('Field "events" must be an array of event names');
                  }
                  for (const ev of body.events) {
                    if (typeof ev !== "string" || !VALID_NOTIFICATION_EVENTS.has(ev)) {
                      throw new ValidationError(`Invalid event name "${String(ev)}"`);
                    }
                  }
                  events = body.events as ("completed" | "failed" | "cancelled" | "timeout" | "started")[];
                }

                const enabled = body.enabled !== undefined ? Boolean(body.enabled) : undefined;

                try {
                  const updated = await taskNotificationService.updateSubscription({
                    id: subId,
                    userId: user.id,
                    destination,
                    secret,
                    events,
                    enabled,
                  });
                  if (!updated) {
                    throw new NotFoundError(`Subscription "${subId}" not found`);
                  }
                  sendJsonResponse(res, 200, createSuccessEnvelope(updated));
                  return;
                } catch (err: unknown) {
                  if (err instanceof WebhookSecurityError) {
                    throw new ValidationError(`Webhook destination rejected: ${err.message}`);
                  }
                  throw err;
                }
              }

              if (method === "DELETE") {
                validateCsrf(req, { csrfToken });
                const deleted = await taskNotificationService.deleteSubscription(subId, user.id);
                if (!deleted) {
                  throw new NotFoundError(`Subscription "${subId}" not found`);
                }
                sendJsonResponse(res, 200, createSuccessEnvelope({ deleted: true, id: subId }));
                return;
              }

              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }

            // Task Notifications: Test Webhook
            if (action === "/notifications/test") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, ALLOWED_TEST_WEBHOOK_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }

              if (!body.url || typeof body.url !== "string" || !body.url.trim()) {
                throw new ValidationError('Field "url" is required and must be a non-empty string');
              }

              const secret = body.secret !== undefined && body.secret !== null ? String(body.secret) : undefined;

              try {
                const testResult = await taskNotificationService.testWebhook({
                  userId: user.id,
                  url: body.url.trim(),
                  secret,
                });
                sendJsonResponse(res, 200, createSuccessEnvelope(testResult));
                return;
              } catch (err: unknown) {
                if (err instanceof WebhookSecurityError) {
                  throw new ValidationError(`Webhook destination rejected: ${err.message}`);
                }
                throw err;
              }
            }

            // Task Notifications: Deliveries
            if (action === "/notifications/deliveries") {
              if (method !== "GET") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");
              const limit = limitParam !== null ? parseLimit(limitParam) : 50;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : 0;

              const deliveries = await taskNotificationService.listDeliveries(taskId, user.id, limit, offset);
              sendJsonResponse(res, 200, createSuccessEnvelope(deliveries));
              return;
            }

            if (action.startsWith("/notifications/deliveries/") && action.endsWith("/retry")) {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              const deliveryId = validatePathId(
                action.slice("/notifications/deliveries/".length, -"/retry".length),
                "deliveryId"
              );

              const retried = await taskNotificationService.retryDelivery(deliveryId, user.id);
              if (!retried) {
                throw new NotFoundError(`Delivery "${deliveryId}" not found`);
              }
              sendJsonResponse(res, 200, createSuccessEnvelope(retried));
              return;
            }
          }
        }

        // 7.3 Deliveries: GET /api/manage/deliveries
        if (managePath === "deliveries") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const statusParam = parsedUrl.searchParams.get("status");
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");

          if (statusParam !== null && !VALID_DELIVERY_STATUSES.has(statusParam)) {
            throw new ValidationError("Invalid delivery status filter");
          }
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const deliveries = await cds.listDeliveries({
            userId: user.id,
            status: statusParam || undefined,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(deliveries));
          return;
        }

        // 7.4 Quotas: /api/manage/quotas & /api/manage/quota*
        if (managePath === "quotas" || managePath === "quota" || managePath === "quota/check") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          if (managePath === "quota/check") {
            if (!opsProvider) {
              throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
            }
            for (const key of parsedUrl.searchParams.keys()) {
              if (key !== "metrics") {
                throw new ValidationError(`Unexpected query parameter "${key}"`);
              }
            }
            const metricsParam = parsedUrl.searchParams.get("metrics");
            if (metricsParam !== null && metricsParam !== "all") {
              throw new ValidationError('Invalid "metrics" query parameter, expected "all"');
            }
            const quota = await opsProvider.checkQuota(user.id);
            sendJsonResponse(res, 200, createSuccessEnvelope(quota));
            return;
          }
          const quotas = await cds.listQuotas({ userId: user.id });
          sendJsonResponse(res, 200, createSuccessEnvelope(quotas));
          return;
        }

        // 7.5 Audit: GET /api/manage/audit
        if (managePath === "audit") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const actionParam = parsedUrl.searchParams.get("action");
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");

          if (actionParam !== null && !VALID_AUDIT_ACTIONS.has(actionParam)) {
            throw new ValidationError("Invalid audit action filter");
          }
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const audit = await cds.listAuditLogs({
            userId: user.id,
            action: actionParam || undefined,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(audit));
          return;
        }

        // 7.6 Imports: GET /api/manage/imports
        if (managePath === "imports") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const imports = await cds.listImports({
            userId: user.id,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(imports));
          return;
        }

        // 7.6.1 Migrations: /api/manage/migrations/*
        if (managePath.startsWith("migrations/") || managePath === "migrations") {
          if (happyClawMigrationRoutes) {
            const handled = await happyClawMigrationRoutes.handle(req, res, pathname, user);
            if (handled) return;
          }
        }

        // 7.7 Agent Profiles: /api/manage/agent-profiles*
        if (managePath === "agent-profiles" || managePath.startsWith("agent-profiles/")) {
          if (!agentProfileApi) {
            throw new PlatformError("Agent Profile service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }

          const profileSub = managePath === "agent-profiles" ? "" : managePath.slice("agent-profiles/".length);

          if (profileSub === "") {
            if (method === "GET") {
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");
              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const profiles = await agentProfileApi.listProfiles(user.id, { limit, offset });
              sendJsonResponse(res, 200, createSuccessEnvelope(profiles));
              return;
            }

            if (method === "POST") {
              validateCsrf(req, { csrfToken });
                  const idempotencyKey = requireIdempotencyKey(req);
              const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, ALLOWED_PROFILE_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }

              const created = await agentProfileApi.createProfile(user.id, body as any, idempotencyKey);
              sendJsonResponse(res, 201, createSuccessEnvelope(created));
              return;
            }
          }

          const profileMatch = profileSub.match(/^([^/]+)(.*)$/);
          if (profileMatch) {
            const profileId = validatePathId(profileMatch[1], "profileId");
            const action = profileMatch[2];

            if (action === "" || action === "/") {
              if (method === "GET") {
                const profile = await agentProfileApi.getProfile(user.id, profileId);
                if (!profile) {
                  throw new NotFoundError(`Agent Profile "${profileId}" not found`);
                }
                sendJsonResponse(res, 200, createSuccessEnvelope(profile));
                return;
              }

              if (method === "DELETE") {
                validateCsrf(req, { csrfToken });
                      const archived = await agentProfileApi.archiveProfile(user.id, profileId);
                sendJsonResponse(res, 200, createSuccessEnvelope(archived));
                return;
              }
            }

            if (action === "/rollback") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              const idempKey = requireIdempotencyKey(req);
              const body = await parseJsonBody(req, maxBodyBytes);
              if (!isRecord(body)) {
                throw new ValidationError("Request body must be an object");
              }
              const unknownKeys = getUnknownKeys(body, new Set(["targetVersion", "changeSummary"]));
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }
              const targetVersion = body.targetVersion;
              if (typeof targetVersion !== "number" || !Number.isSafeInteger(targetVersion) || targetVersion < 1) {
                throw new ValidationError('Field "targetVersion" must be a positive safe integer');
              }
              const changeSummary = typeof body.changeSummary === "string" ? body.changeSummary : undefined;

              const rolledBack = await agentProfileApi.rollbackProfileVersion(
                user.id,
                profileId,
                { targetVersion, changeSummary },
                idempKey,
                user
              );
              sendJsonResponse(res, 200, createSuccessEnvelope(rolledBack));
              return;
            }

            if (action === "/versions" || action.startsWith("/versions/")) {
              const verSub = action === "/versions" ? "" : action.slice("/versions/".length);

              if (verSub === "") {
                if (method === "GET") {
                  const versions = await agentProfileApi.listVersions(user.id, profileId);
                  sendJsonResponse(res, 200, createSuccessEnvelope(versions));
                  return;
                }

                if (method === "POST") {
                  validateCsrf(req, { csrfToken });
                          const idempKey = req.headers["idempotency-key"] as string | undefined;
                  const body = await parseJsonBody(req, maxBodyBytes);
                  const unknownKeys = getUnknownKeys(body, ALLOWED_PROFILE_VERSION_KEYS);
                  if (unknownKeys.length > 0) {
                    throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                  }

                  const version = await agentProfileApi.createVersion(user.id, profileId, body as any, idempKey);
                  sendJsonResponse(res, 201, createSuccessEnvelope(version));
                  return;
                }
              }

              const verNum = Number(verSub);
              if (Number.isInteger(verNum) && verNum >= 1) {
                if (method === "GET") {
                  const version = await agentProfileApi.getVersion(user.id, profileId, verNum);
                  if (!version) {
                    throw new NotFoundError(`Profile version ${verNum} not found`);
                  }
                  sendJsonResponse(res, 200, createSuccessEnvelope(version));
                  return;
                }
              }
            }
          }
        }

        // 7.8 Permission Presets: /api/manage/permission-presets*
        if (managePath === "permission-presets" || managePath.startsWith("permission-presets/")) {
          const permRepo = (storage as SqlitePlatformStorage).forTenant(user.id).permissionPresets;
          const permSub = managePath === "permission-presets" ? "" : managePath.slice("permission-presets".length);

          if (permSub === "" || permSub === "/") {
            if (method === "GET") {
              const list = await permRepo.listPresets();
              sendJsonResponse(res, 200, createSuccessEnvelope(list));
              return;
            }

            if (method === "PUT" || method === "POST") {
              validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);

              if (typeof body.preset !== "string" || !["read-only", "workspace-write", "danger-full-access", "custom"].includes(body.preset)) {
                throw new ValidationError('Field "preset" must be one of "read-only", "workspace-write", "danger-full-access", "custom"');
              }

              const spaceId = body.spaceId ? validatePathId(body.spaceId, "spaceId") : null;
              if (spaceId) {
                const space = await platformApi.getSpace(user.id, spaceId);
                if (!space && user.role !== "admin") {
                  throw new NotFoundError(`Space "${spaceId}" not found`);
                }
              }

              const profileId = body.profileId ? validatePathId(body.profileId, "profileId") : null;
              if (profileId) {
                const checkDb = db ?? (storage as SqlitePlatformStorage).db;
                if (checkDb) {
                  const profStmt = checkDb.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND user_id = ?');
                  const foundProf = profStmt.get(profileId, user.id);
                  if (!foundProf && user.role !== "admin") {
                    throw new NotFoundError(`Profile "${profileId}" not found`);
                  }
                }
              }

              const revision = typeof body.revision === "number" && Number.isSafeInteger(body.revision) ? body.revision : undefined;
              const preset = body.preset as import("@enkeep/platform-core").PermissionPresetName;
              const sandboxMode = (body.sandboxMode === "read-only" || body.sandboxMode === "workspace-write" || body.sandboxMode === "danger-full-access")
                ? (body.sandboxMode as import("@enkeep/platform-core").SandboxMode)
                : undefined;
              const approvalPolicy = (body.approvalPolicy === "ask" || body.approvalPolicy === "never")
                ? (body.approvalPolicy as import("@enkeep/platform-core").ApprovalPolicy)
                : undefined;

              const saved = await permRepo.setPreset({
                id: body.id ? String(body.id) : undefined,
                userId: user.id,
                spaceId,
                profileId,
                preset,
                sandboxMode,
                approvalPolicy,
                revision,
              });

              sendJsonResponse(res, 200, createSuccessEnvelope(saved));
              return;
            }

            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          if (permSub === "/effective") {
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            const spaceIdParam = parsedUrl.searchParams.get("spaceId") || undefined;
            const profileIdParam = parsedUrl.searchParams.get("profileId") || undefined;

            if (spaceIdParam) {
              validatePathId(spaceIdParam, "spaceId");
              const space = await platformApi.getSpace(user.id, spaceIdParam);
              if (!space && user.role !== "admin") {
                throw new NotFoundError(`Space "${spaceIdParam}" not found`);
              }
            }

            if (profileIdParam) {
              validatePathId(profileIdParam, "profileId");
            }

            const effective = await permRepo.getEffectivePreset({
              userId: user.id,
              spaceId: spaceIdParam,
              profileId: profileIdParam,
            });

            const result = effective ?? {
              id: "default",
              userId: user.id,
              spaceId: spaceIdParam ?? null,
              profileId: profileIdParam ?? null,
              preset: "workspace-write",
              sandboxMode: "workspace-write",
              approvalPolicy: "ask",
              revision: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            sendJsonResponse(res, 200, createSuccessEnvelope(result));
            return;
          }

          // Subpath: /api/manage/permission-presets/:presetId (DELETE or GET)
          const presetId = permSub.startsWith("/") ? permSub.slice(1) : permSub;
          if (!presetId) {
            throw new ValidationError("Preset ID is required");
          }

          if (method === "DELETE") {
            validateCsrf(req, { csrfToken });
            const deleted = await permRepo.deletePreset(presetId);
            if (!deleted) {
              throw new NotFoundError(`Permission preset "${presetId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope({ deleted: true, id: presetId }));
            return;
          }

          if (method === "GET") {
            const preset = await permRepo.getPresetById(presetId);
            if (!preset) {
              throw new NotFoundError(`Permission preset "${presetId}" not found`);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(preset));
            return;
          }

          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }
      }

      // 8. Admin Routes (/api/admin/* and /api/v1/admin/*)
      const adminMatch = pathname.match(/^\/api(?:\/v1)?\/admin(.*)$/);
      if (adminMatch) {
        const user = await getRequiredAuthUser(req);
        if (user.role !== "admin") {
          throw new ForbiddenError("Administrative access required");
        }

        const adminSub = adminMatch[1];

        // 8.1 Dashboard: GET /api/admin/dashboard
        if (adminSub === "/dashboard") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          let containerKpi: AdminDashboardContainerKpi | undefined = undefined;
          let runtimeSummary: {
            available: boolean;
            providerAttached: boolean;
            status: "available" | "unavailable" | "error";
            activeContainers: number | null;
            healthyContainers: number | null;
            totalContainers: number | null;
            summary: {
              totalRuntimes: number;
              healthyRuntimes: number;
              activeRuntimes: number;
              allDshReady: boolean;
              toolsOperationalCount: number;
            } | null;
          } = {
            available: false,
            providerAttached: false,
            status: "unavailable",
            activeContainers: null,
            healthyContainers: null,
            totalContainers: null,
            summary: null,
          };

          if (managementProvider) {
            try {
              const rawRuntimes = await managementProvider.listRuntimes();
              if (Array.isArray(rawRuntimes)) {
                let activeCount = 0;
                let healthyCount = 0;
                let toolsOperationalCount = 0;
                const totalCount = rawRuntimes.length;
                let allDshReady = totalCount > 0;
                let allValid = true;
                for (const r of rawRuntimes) {
                  const validated = validateUserRuntimeStatus(r);
                  if (!validated) {
                    allValid = false;
                    break;
                  }
                  if (validated.status === "ok" || validated.status === "degraded") {
                    activeCount++;
                  }
                  if (validated.status === "ok") {
                    healthyCount++;
                  }
                  if (validated.toolsOperational) {
                    toolsOperationalCount++;
                  }
                  if (!validated.dshReady) {
                    allDshReady = false;
                  }
                }
                if (allValid) {
                  containerKpi = {
                    available: true,
                    active: activeCount,
                    healthy: healthyCount,
                    total: totalCount,
                    status: "available",
                  };
                  runtimeSummary = {
                    available: true,
                    providerAttached: true,
                    status: "available",
                    activeContainers: activeCount,
                    healthyContainers: healthyCount,
                    totalContainers: totalCount,
                    summary: {
                      totalRuntimes: totalCount,
                      healthyRuntimes: healthyCount,
                      activeRuntimes: activeCount,
                      allDshReady,
                      toolsOperationalCount,
                    },
                  };
                } else {
                  containerKpi = {
                    available: false,
                    active: null,
                    healthy: null,
                    total: null,
                    status: "error",
                  };
                  runtimeSummary = {
                    available: false,
                    providerAttached: true,
                    status: "error",
                    activeContainers: null,
                    healthyContainers: null,
                    totalContainers: null,
                    summary: null,
                  };
                }
              }
            } catch {
              containerKpi = {
                available: false,
                active: null,
                healthy: null,
                total: null,
                status: "error",
              };
              runtimeSummary = {
                available: false,
                providerAttached: true,
                status: "error",
                activeContainers: null,
                healthyContainers: null,
                totalContainers: null,
                summary: null,
              };
            }
          }

          const counts = await cds.getDashboardCounts();
          const kpis = await cds.getDashboardKpis(containerKpi);

          sendJsonResponse(res, 200, createSuccessEnvelope({
            counts,
            kpis,
            runtime: runtimeSummary,
            schema: counts.schema,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          }));
          return;
        }

        // 8.2 Users: /api/admin/users*
        if (adminSub === "/users" || adminSub.startsWith("/users/")) {
          const userSub = adminSub === "/users" ? "" : adminSub.slice("/users/".length);

          if (userSub === "") {
            if (method === "GET") {
              const roleParam = parsedUrl.searchParams.get("role");
              const statusParam = parsedUrl.searchParams.get("status");
              const searchParam = parsedUrl.searchParams.get("search");
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");

              if (roleParam !== null && !VALID_USER_ROLES.has(roleParam)) {
                throw new ValidationError("Invalid role filter");
              }
              if (statusParam !== null && !VALID_USER_STATUSES.has(statusParam)) {
                throw new ValidationError("Invalid status filter");
              }
              if (searchParam !== null) {
                validateExactTrimmed(searchParam, "search");
              }
              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const users = await cds.listUsers({
                role: roleParam || undefined,
                status: statusParam || undefined,
                search: searchParam || undefined,
                limit,
                offset,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope(users));
              return;
            }

            if (method === "POST") {
              validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
              const unknownKeys = getUnknownKeys(body, new Set(["username", "displayName", "role", "tempPassword", "locale", "theme"]));
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }
              if (!body.username || typeof body.username !== "string" || !body.username.trim()) {
                throw new ValidationError('Field "username" is required');
              }
              if (body.role !== undefined && !VALID_USER_ROLES.has(body.role as string)) {
                throw new ValidationError("Invalid role value: must be 'admin' or 'user'");
              }
              if (body.locale !== undefined && body.locale !== "en" && body.locale !== "zh-CN") {
                throw new ValidationError("Invalid locale value: must be 'en' or 'zh-CN'");
              }
              if (body.theme !== undefined && body.theme !== "dark" && body.theme !== "light" && body.theme !== "eye-care") {
                throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
              }

              const result = await cds.createUser({
                username: body.username as string,
                displayName: typeof body.displayName === "string" ? body.displayName : null,
                role: body.role as "admin" | "user",
                locale: body.locale as "en" | "zh-CN" | undefined,
                theme: body.theme as "dark" | "light" | "eye-care" | undefined,
                tempPassword: typeof body.tempPassword === "string" ? body.tempPassword : undefined,
              }, user.id);

              sendJsonResponse(res, 201, createSuccessEnvelope(result));
              return;
            }
          }

          const targetUserMatch = userSub.match(/^([^/]+)(.*)$/);
          if (targetUserMatch) {
            const targetUserId = validatePathId(targetUserMatch[1], "userId");
            const action = targetUserMatch[2];

            if (action === "" || action === "/") {
              if (method === "PATCH") {
                validateCsrf(req, { csrfToken });
                      const body = await parseJsonBody(req, maxBodyBytes);
                if (Object.keys(body).length === 0) {
                  throw new ValidationError("Request body cannot be empty");
                }
                const unknownKeys = getUnknownKeys(body, new Set(["role", "status", "displayName", "locale", "theme"]));
                if (unknownKeys.length > 0) {
                  throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                }
                if (body.role !== undefined && !VALID_USER_ROLES.has(body.role as string)) {
                  throw new ValidationError("Invalid role value");
                }
                if (body.status !== undefined && !VALID_USER_STATUSES.has(body.status as string)) {
                  throw new ValidationError("Invalid status value");
                }
                if (body.locale !== undefined && body.locale !== "en" && body.locale !== "zh-CN") {
                  throw new ValidationError("Invalid locale value: must be 'en' or 'zh-CN'");
                }
                if (body.theme !== undefined && body.theme !== "dark" && body.theme !== "light" && body.theme !== "eye-care") {
                  throw new ValidationError("Invalid theme value: must be 'dark', 'light', or 'eye-care'");
                }
                if (body.displayName !== undefined && body.displayName !== null) {
                  if (typeof body.displayName !== "string" || body.displayName !== body.displayName.trim() || body.displayName.length > 64) {
                    throw new ValidationError("Invalid displayName");
                  }
                }
                const updated = await cds.patchUser(targetUserId, body as any, user.id);
                if (body.status === 'disabled' && managementProvider && typeof managementProvider.stopRuntime === 'function') {
                  try {
                    await managementProvider.stopRuntime(targetUserId);
                  } catch {}
                }
                sendJsonResponse(res, 200, createSuccessEnvelope(updated));
                return;
              }
            }

            if (action === "/reset-password") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
                  const rawBody = await readBody(req, maxBodyBytes);
              let customTempPassword: string | undefined = undefined;
              if (rawBody.trim().length > 0) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(rawBody);
                } catch {
                  throw new ValidationError("Malformed JSON body");
                }
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  const unknownKeys = getUnknownKeys(parsed as Record<string, unknown>, new Set(["tempPassword"]));
                  if (unknownKeys.length > 0) {
                    throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
                  }
                  if ((parsed as any).tempPassword !== undefined) {
                    if (typeof (parsed as any).tempPassword !== "string") {
                      throw new ValidationError("Invalid tempPassword: must be a string");
                    }
                    customTempPassword = (parsed as any).tempPassword;
                  }
                } else {
                  throw new ValidationError("Reset password request body must be an object");
                }
              }

              const result = await cds.resetUserPassword(targetUserId, user.id, customTempPassword);
              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }

            if (action === "/revoke-sessions") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
                  const rawBody = await readBody(req, maxBodyBytes);
              if (rawBody.trim().length > 0) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(rawBody);
                } catch {
                  throw new ValidationError("Malformed JSON body");
                }
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
                  throw new ValidationError("Revoke sessions request body must be empty or empty object");
                }
              }
              const result = await cds.revokeUserSessions(targetUserId, user.id);
              if (result.forceLogout) {
                res.setHeader(
                  "Set-Cookie",
                  "enkeep_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Strict"
                );
              }
              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }

            if (action === "/deactivate") {
              if (method !== "POST") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              const updated = await cds.patchUser(targetUserId, { status: "disabled" }, user.id);
              if (managementProvider && typeof managementProvider.stopRuntime === "function") {
                try {
                  await managementProvider.stopRuntime(targetUserId);
                } catch {}
              }
              sendJsonResponse(res, 200, createSuccessEnvelope(updated));
              return;
            }
          }
        }

        // 8.3 Spaces: /api/admin/spaces*
        if (adminSub === "/spaces" || adminSub.startsWith("/spaces/")) {
          if (adminSub === "/spaces") {
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            const searchParam = parsedUrl.searchParams.get("search");
            const statusParam = parsedUrl.searchParams.get("status");
            const userIdParam = parsedUrl.searchParams.get("userId");
            const limitParam = parsedUrl.searchParams.get("limit");
            const offsetParam = parsedUrl.searchParams.get("offset");

            if (statusParam !== null && !VALID_SPACE_STATUSES.has(statusParam)) {
              throw new ValidationError("Invalid status filter");
            }
            if (userIdParam !== null) {
              validatePathId(userIdParam, "userId");
            }
            if (searchParam !== null) {
              validateExactTrimmed(searchParam, "search");
            }
            const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
            const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

            const spaces = await cds.listSpaces({
              search: searchParam || undefined,
              userId: userIdParam || undefined,
              limit,
              offset,
            });
            sendJsonResponse(res, 200, createSuccessEnvelope(spaces));
            return;
          }

          // Admin Space Sub-resources: /api/admin/spaces/:spaceId/mounts
          const spaceMountMatch = adminSub.match(/^\/spaces\/([^/]+)\/mounts(?:\/(.+))?$/);
          if (spaceMountMatch) {
            if (!spaceMountService) {
              throw new PlatformError("Space mount service unavailable", "SERVICE_UNAVAILABLE", 503);
            }

            const rawSpaceId = spaceMountMatch[1];
            const spaceId = validatePathId(rawSpaceId, "spaceId");
            const rawMountId = spaceMountMatch[2];

            // Verify space exists and get owner userId
            const spaceRow = db?.prepare('SELECT id, user_id, execution_mode FROM spaces WHERE id = ?').get(spaceId) as { id: string; user_id: string; execution_mode: string } | undefined;
            if (!spaceRow) {
              throw new NotFoundError(`Space "${spaceId}" not found`);
            }
            const targetUserId = spaceRow.user_id;

            if (method === "GET") {
              // Exact: GET collection only, not item
              if (rawMountId) {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }

              // GET /api/admin/spaces/:spaceId/mounts -> { mounts: [{ id, name, sourcePath, mode, createdAt }] }
              const mounts = await spaceMountService.listMounts(targetUserId, spaceId);
              sendJsonResponse(res, 200, createSuccessEnvelope({ mounts }));
              return;
            }

            if (method === "POST") {
              if (rawMountId) {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
              if (!isRecord(body) || Object.keys(body).length === 0) {
                throw new ValidationError("Request body cannot be empty");
              }
              const unknownKeys = getUnknownKeys(body, ALLOWED_SPACE_MOUNT_CREATE_KEYS);
              if (unknownKeys.length > 0) {
                throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
              }

              if (typeof body.name !== "string" || !body.name.trim()) {
                throw new ValidationError('Field "name" must be a non-empty string');
              }
              if (body.name !== body.name.trim()) {
                throw new ValidationError('Field "name" must not contain leading or trailing whitespace');
              }
              if (typeof body.sourcePath !== "string" || !body.sourcePath.trim()) {
                throw new ValidationError('Field "sourcePath" must be a non-empty string');
              }
              if (body.sourcePath !== body.sourcePath.trim()) {
                throw new ValidationError('Field "sourcePath" must not contain leading or trailing whitespace');
              }
              if (typeof body.mode !== "string" || (body.mode !== "ro" && body.mode !== "rw")) {
                throw new ValidationError('Field "mode" is required and must be either "ro" or "rw"');
              }

              const created = await spaceMountService.createMount(
                targetUserId,
                spaceId,
                {
                  name: body.name,
                  sourcePath: body.sourcePath,
                  mode: body.mode,
                },
                {
                  username: user.username,
                  ipAddress: req.socket.remoteAddress,
                  userAgent: req.headers["user-agent"],
                }
              );

              sendJsonResponse(res, 201, createSuccessEnvelope(created));
              return;
            }

            if (method === "DELETE") {
              validateCsrf(req, { csrfToken });
              if (!rawMountId) {
                throw new ValidationError('Missing required "mountId" in URL path');
              }
              const mountId = validatePathId(rawMountId, "mountId");

              const result = await spaceMountService.deleteMount(
                targetUserId,
                spaceId,
                mountId,
                {
                  username: user.username,
                  ipAddress: req.socket.remoteAddress,
                  userAgent: req.headers["user-agent"],
                }
              );

              sendJsonResponse(res, 200, createSuccessEnvelope(result));
              return;
            }

            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
        }

        // 8.4 Tasks: GET /api/admin/tasks & GET /api/admin/tasks/:taskId/runs
        if (adminSub === "/tasks" || adminSub.startsWith("/tasks/")) {
          const taskSub = adminSub === "/tasks" ? "" : adminSub.slice("/tasks/".length);

          if (taskSub === "") {
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            const statusParam = parsedUrl.searchParams.get("status");
            const priorityParam = parsedUrl.searchParams.get("priority");
            const userIdParam = parsedUrl.searchParams.get("userId");
            const limitParam = parsedUrl.searchParams.get("limit");
            const offsetParam = parsedUrl.searchParams.get("offset");

            if (statusParam !== null && !VALID_TASK_STATUSES.has(statusParam)) {
              throw new ValidationError("Invalid task status filter");
            }
            if (priorityParam !== null && !VALID_TASK_PRIORITIES.has(priorityParam)) {
              throw new ValidationError("Invalid task priority filter");
            }
            if (userIdParam !== null) {
              validatePathId(userIdParam, "userId");
            }
            const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
            const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

            const tasks = await cds.listTasks({
              status: statusParam as any || undefined,
              priority: priorityParam as any || undefined,
              userId: userIdParam || undefined,
              limit,
              offset,
            });
            sendJsonResponse(res, 200, createSuccessEnvelope(tasks));
            return;
          }

          const taskIdMatch = taskSub.match(/^([^/]+)(.*)$/);
          if (taskIdMatch) {
            const taskId = validatePathId(taskIdMatch[1], "taskId");
            const action = taskIdMatch[2];

            if (action === "/runs") {
              if (method !== "GET") {
                throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
              }
              const statusParam = parsedUrl.searchParams.get("status");
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");

              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const runs = await cds.listTaskRuns({
                taskId,
                status: statusParam || undefined,
                limit,
                offset,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope(runs));
              return;
            }
          }
        }

        // 8.5 Deliveries: GET /api/admin/deliveries
        if (adminSub === "/deliveries") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const statusParam = parsedUrl.searchParams.get("status");
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");

          if (statusParam !== null && !VALID_DELIVERY_STATUSES.has(statusParam)) {
            throw new ValidationError("Invalid delivery status filter");
          }
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const deliveries = await cds.listDeliveries({
            status: statusParam || undefined,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(deliveries));
          return;
        }

        // 8.6 Quotas: /api/admin/quotas*
        if (adminSub === "/quotas" || adminSub.startsWith("/quotas/")) {
          const quotaSub = adminSub === "/quotas" ? "" : adminSub.slice("/quotas/".length);

          if (quotaSub === "") {
            if (method === "GET") {
              const userIdParam = parsedUrl.searchParams.get("userId");
              const limitParam = parsedUrl.searchParams.get("limit");
              const offsetParam = parsedUrl.searchParams.get("offset");

              if (userIdParam !== null) {
                validatePathId(userIdParam, "userId");
              }
              const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
              const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

              const quotas = await cds.listQuotas({
                userId: userIdParam || undefined,
                limit,
                offset,
              });
              sendJsonResponse(res, 200, createSuccessEnvelope(quotas));
              return;
            }
          }

          const quotaTargetMatch = quotaSub.match(/^([^/]+)\/([^/]+)$/);
          if (quotaTargetMatch && method === "PATCH") {
            validateCsrf(req, { csrfToken });
              const targetUserId = validatePathId(quotaTargetMatch[1], "userId");
            const rawMetric = quotaTargetMatch[2];

            if (!VALID_QUOTA_METRICS.has(rawMetric)) {
              throw new ValidationError(`Invalid quota metric "${rawMetric}". Expected one of: tokens, messages, turns, storage_bytes, api_calls`);
            }
            if (!operations) {
              throw new PlatformError("Platform Operations service is not configured or unavailable", "OPERATIONS_UNAVAILABLE", 503);
            }

            const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, new Set(["limit", "windowSeconds", "resetAt", "resetInterval", "resetPeriodSeconds"]));
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || (body.limit < 0 && body.limit !== -1)) {
              throw new ValidationError("limit must be a non-negative integer or -1");
            }

            let windowSeconds = 3600;
            if (body.windowSeconds !== undefined) {
              if (typeof body.windowSeconds !== "number" || !Number.isInteger(body.windowSeconds) || body.windowSeconds <= 0) {
                throw new ValidationError("windowSeconds must be a positive integer");
              }
              windowSeconds = body.windowSeconds;
            } else if (body.resetPeriodSeconds !== undefined) {
              if (typeof body.resetPeriodSeconds !== "number" || !Number.isInteger(body.resetPeriodSeconds) || body.resetPeriodSeconds <= 0) {
                throw new ValidationError("resetPeriodSeconds must be a positive integer");
              }
              windowSeconds = body.resetPeriodSeconds;
            }

            let resetAt: string | undefined = undefined;
            if (body.resetAt !== undefined) {
              if (typeof body.resetAt !== "string" || !isValidIsoDate(body.resetAt)) {
                throw new ValidationError("resetAt must be a valid ISO 8601 string");
              }
              resetAt = body.resetAt;
            }

            let resetInterval: string | undefined = undefined;
            if (body.resetInterval !== undefined) {
              if (typeof body.resetInterval !== "string" || !["none", "daily", "monthly"].includes(body.resetInterval)) {
                throw new ValidationError('resetInterval must be one of: "none", "daily", "monthly"');
              }
              resetInterval = body.resetInterval;
            }

            const updatedLimit = opsProvider
              ? await opsProvider.setQuotaLimit(targetUserId, {
                  resource: rawMetric as QuotaMetric,
                  limit: body.limit,
                  windowSeconds,
                  resetAt,
                  resetInterval,
                })
              : await operations.forTenant(targetUserId).quota.setLimit({
                  resource: rawMetric as QuotaMetric,
                  limit: body.limit,
                  windowSeconds,
                  resetAt,
                  resetInterval,
                });
            if (!updatedLimit || !updatedLimit.updatedAt || !isValidIsoDate(updatedLimit.updatedAt)) {
              throw new PlatformError("invalid or missing updatedAt returned from quota service", "BAD_GATEWAY", 502);
            }
            sendJsonResponse(res, 200, createSuccessEnvelope(updatedLimit));
            return;
          }
        }

        // 8.7 Audit: GET /api/admin/audit & GET /api/admin/audit/export
        if (adminSub === "/audit/export") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const formatParam = parsedUrl.searchParams.get("format");
          const format = formatParam === "jsonl" ? "jsonl" : "csv";
          const from = parsedUrl.searchParams.get("from") || undefined;
          const to = parsedUrl.searchParams.get("to") || undefined;
          const action = parsedUrl.searchParams.get("action") || undefined;
          const userIdParam = parsedUrl.searchParams.get("userId") || undefined;
          const limitParam = parsedUrl.searchParams.get("limit");
          const limit = limitParam !== null ? parseLimit(limitParam) : 10000;

          if (action && !VALID_AUDIT_ACTIONS.has(action)) {
            throw new ValidationError("Invalid audit action filter");
          }
          if (userIdParam) {
            validatePathId(userIdParam, "userId");
          }

          await auditExportService.exportAuditLogs(
            req,
            res,
            {
              format,
              from,
              to,
              action,
              userId: userIdParam,
              limit,
            },
            {
              id: user.id,
              username: user.username,
              ipAddress: clientIp,
            }
          );
          return;
        }

        if (adminSub === "/audit") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const actionParam = parsedUrl.searchParams.get("action");
          const userIdParam = parsedUrl.searchParams.get("userId");
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");

          if (actionParam !== null && !VALID_AUDIT_ACTIONS.has(actionParam)) {
            throw new ValidationError("Invalid audit action filter");
          }
          if (userIdParam !== null) {
            validatePathId(userIdParam, "userId");
          }
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const audit = await cds.listAuditLogs({
            action: actionParam || undefined,
            userId: userIdParam || undefined,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(audit));
          return;
        }

        // 8.7.1 Usage Export: GET /api/admin/usage/export
        if (adminSub === "/usage/export" || adminSub === "/usage") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const formatParam = parsedUrl.searchParams.get("format");
          const format = formatParam === "jsonl" ? "jsonl" : "csv";
          const from = parsedUrl.searchParams.get("from") || undefined;
          const to = parsedUrl.searchParams.get("to") || undefined;
          const model = parsedUrl.searchParams.get("model") || undefined;
          const userIdParam = parsedUrl.searchParams.get("userId") || undefined;
          const limitParam = parsedUrl.searchParams.get("limit");
          const limit = limitParam !== null ? parseLimit(limitParam) : 10000;

          if (userIdParam) {
            validatePathId(userIdParam, "userId");
          }

          await usageExportService.exportUsage(
            req,
            res,
            {
              format,
              from,
              to,
              model,
              userId: userIdParam,
              limit,
            },
            {
              id: user.id,
              username: user.username,
              ipAddress: clientIp,
            }
          );
          return;
        }

        // 8.8 Imports: Staged DB migration and list imports
        if (adminSub.startsWith("/imports/staged") || adminSub.startsWith("/migrations")) {
          if (happyClawMigrationRoutes) {
            const handled = await happyClawMigrationRoutes.handle(req, res, pathname, user);
            if (handled) return;
          }
        }

        if (adminSub === "/imports") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const userIdParam = parsedUrl.searchParams.get("userId");
          const limitParam = parsedUrl.searchParams.get("limit");
          const offsetParam = parsedUrl.searchParams.get("offset");

          if (userIdParam !== null) {
            validatePathId(userIdParam, "userId");
          }
          const limit = limitParam !== null ? parseLimit(limitParam) : undefined;
          const offset = offsetParam !== null ? parseOffset(offsetParam) : undefined;

          const imports = await cds.listImports({
            userId: userIdParam || undefined,
            limit,
            offset,
          });
          sendJsonResponse(res, 200, createSuccessEnvelope(imports));
          return;
        }

        // 8.9 Security: GET /api/admin/security
        if (adminSub === "/security") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const security = await cds.getSecurityData(limits);
          sendJsonResponse(res, 200, createSuccessEnvelope(security));
          return;
        }

        // 8.10 Runtime: GET /api/admin/runtime, POST /api/admin/runtime/restart, or /runtimes
        if (adminSub === "/runtime" || adminSub === "/runtimes" || adminSub.startsWith("/runtime/") || adminSub.startsWith("/runtimes/")) {
          if (
            (adminSub.startsWith("/runtimes/") && adminSub.endsWith("/diagnostics")) ||
            (adminSub.startsWith("/runtime/") && adminSub.endsWith("/diagnostics"))
          ) {
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            const match = adminSub.match(/^\/runtimes?\/([^/]+)\/diagnostics$/);
            if (!match) {
              throw new NotFoundError("Not Found");
            }
            const targetUserId = validatePathId(match[1], "userId");
            const before = parsedUrl.searchParams.get("before") || undefined;
            const level = parsedUrl.searchParams.get("level") || undefined;
            const limitParam = parsedUrl.searchParams.get("limit");
            const limit = limitParam !== null ? parseLimit(limitParam) : 50;

            if (level && !["debug", "info", "warn", "error"].includes(level)) {
              throw new ValidationError("Invalid diagnostic level filter");
            }

            const diagnostics = await runtimeDiagnosticsService.queryDiagnostics({
              userId: targetUserId,
              before,
              level: level as any,
              limit,
            });
            sendJsonResponse(res, 200, createSuccessEnvelope(diagnostics));
            return;
          }

          const runtimeSub = adminSub === "/runtime" || adminSub === "/runtimes" ? "" : (adminSub.startsWith("/runtimes/") ? adminSub.slice("/runtimes/".length) : adminSub.slice("/runtime/".length));

          if (runtimeSub === "restart" || runtimeSub.endsWith("/restart")) {
            if (method !== "POST") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            validateCsrf(req, { csrfToken });

            if (!managementProvider || typeof managementProvider.restartRuntime !== "function") {
              sendJsonResponse(res, 200, createSuccessEnvelope({
                restarted: false,
                message: "Runtime provider does not support dynamic restarts; restart will take effect on next container boot.",
                userIds: [],
              }));
              return;
            }

            let targetMode: "container" | "host" | undefined = undefined;
            const rawBody = await readBody(req, maxBodyBytes);
            if (rawBody.trim().length > 0) {
              let parsed: any;
              try {
                parsed = JSON.parse(rawBody);
              } catch {
                throw new ValidationError("Malformed JSON body");
              }
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (parsed.mode !== undefined) {
                  if (parsed.mode !== "container" && parsed.mode !== "host") {
                    throw new ValidationError('Invalid mode: Expected container or host');
                  }
                  targetMode = parsed.mode;
                }
              }
            }

            const targetUserId = runtimeSub === "restart" ? undefined : validatePathId(runtimeSub.slice(0, -"/restart".length), "userId");
            const restartResult = await managementProvider.restartRuntime(targetUserId, { mode: targetMode });
            sendJsonResponse(res, 200, createSuccessEnvelope(restartResult));
            return;
          }

          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          if (!managementProvider) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unavailable",
              message: "No runtime provider configured",
            }));
            return;
          }

          try {
            const rawRuntimes = await managementProvider.listRuntimes();
            if (!Array.isArray(rawRuntimes)) {
              sendJsonResponse(res, 200, createSuccessEnvelope({
                available: false,
                status: "protocol_error",
                message: "Runtime provider returned invalid list shape",
              }));
              return;
            }

            const validatedRuntimes: UserRuntimeStatus[] = [];
            let hasProtocolError = false;
            for (const item of rawRuntimes) {
              const validated = validateUserRuntimeStatus(item);
              if (!validated) {
                hasProtocolError = true;
                break;
              }
              validatedRuntimes.push(validated);
            }

            if (hasProtocolError) {
              sendJsonResponse(res, 200, createSuccessEnvelope({
                available: false,
                status: "protocol_error",
                message: "Runtime provider returned malformed runtime records",
              }));
              return;
            }

            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: true,
              status: "available",
              runtimes: validatedRuntimes,
            }));
            return;
          } catch {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "error",
              message: "Runtime provider unavailable",
            }));
            return;
          }
        }

        // 8.11 Plugins: GET /api/admin/plugins
        if (adminSub === "/plugins") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          if (!managementProvider) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unavailable",
              message: "No runtime provider configured",
              runtimes: [],
            }));
            return;
          }

          try {
            const rawRuntimes = await managementProvider.listRuntimes();
            if (!Array.isArray(rawRuntimes)) {
              sendJsonResponse(res, 200, createSuccessEnvelope({
                available: false,
                status: "protocol_error",
                message: "Runtime provider returned invalid list shape",
                runtimes: [],
              }));
              return;
            }

            const pluginRuntimes: any[] = [];
            for (const item of rawRuntimes) {
              const validated = validateUserRuntimeStatus(item);
              if (!validated) {
                sendJsonResponse(res, 200, createSuccessEnvelope({
                  available: false,
                  status: "protocol_error",
                  message: "Runtime provider returned malformed runtime records",
                  runtimes: [],
                }));
                return;
              }
              pluginRuntimes.push({
                userId: validated.userId,
                status: validated.status,
                dshReady: validated.dshReady,
                toolsCount: validated.toolsCount,
                enkeepBundleLoaded: validated.enkeepBundleLoaded,
                schemasRegistered: true,
                toolsOperational: validated.toolsOperational,
                toolsUnavailableReason: validated.toolsUnavailableReason,
                executionOperational: validated.toolsOperational,
                reason: validated.toolsUnavailableReason,
                plugins: validated.plugins,
                networkMode: validated.networkMode,
                uptimeSeconds: validated.uptimeSeconds,
                version: validated.version,
              });
            }

            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: true,
              status: "available",
              runtimes: pluginRuntimes,
            }));
            return;
          } catch {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "error",
              message: "Plugins provider unavailable",
              runtimes: [],
            }));
            return;
          }
        }

        // 8.11 Browser Diagnostics: GET /api/admin/browser/diagnostics, GET /api/admin/browser/health
        if (adminSub === "/browser/diagnostics" || adminSub === "/browser/health" || adminSub === "/browser") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          if (!browserService) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unavailable",
              activeContexts: 0,
              activePages: 0,
              message: "Browser service is not configured on platform server",
            }));
            return;
          }

          try {
            const health = await browserService.checkHealth();
            // Strict redaction: return context and page counts ONLY, strictly NO URLs or page titles!
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: health.status === "healthy" || health.status === "degraded",
              status: health.status,
              activeContexts: health.activeContexts,
              activePages: health.activePages,
              uptimeSeconds: health.uptimeSeconds,
            }));
          } catch (_healthErr: unknown) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unhealthy",
              activeContexts: 0,
              activePages: 0,
              message: "Browser health check failed",
            }));
          }
          return;
        }

        // 8.11b MCP Diagnostics: GET /api/admin/mcp/diagnostics, GET /api/admin/mcp/health, GET /api/admin/mcp
        if (adminSub === "/mcp/diagnostics" || adminSub === "/mcp/health" || adminSub === "/mcp") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }

          if (!mcpService) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unavailable",
              servers: [],
              message: "MCP service is not configured on platform server",
            }));
            return;
          }

          try {
            const health = await mcpService.checkHealth({ userId: 'system' });
            const isAvailable = Array.isArray(health) && !health.some((h) => h.status === 'unhealthy' || h.status === 'degraded');
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: isAvailable,
              status: isAvailable ? 'healthy' : 'degraded',
              servers: health,
            }));
          } catch (_healthErr: unknown) {
            sendJsonResponse(res, 200, createSuccessEnvelope({
              available: false,
              status: "unhealthy",
              servers: [],
              message: "MCP health check failed",
            }));
          }
          return;
        }

        // 8.12 Model Config: GET /api/admin/model-config, PATCH /api/admin/model-config
        if (adminSub === "/model-config") {
          if (method === "GET") {
            const projection = await cds.getModelConfig();
            sendJsonResponse(res, 200, createSuccessEnvelope(projection));
            return;
          }

          if (method === "PATCH") {
            validateCsrf(req, { csrfToken });
            const rawBody = await parseJsonBody(req, maxBodyBytes);
            if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
              throw new ValidationError("Request body cannot be empty");
            }
            const unknownKeys = getUnknownKeys(rawBody, new Set(["provider", "model", "reasoningEffort", "fallbackChain", "clear", "applyMode", "ifMatch"]));
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            if (rawBody.provider !== undefined && typeof rawBody.provider !== 'string' && rawBody.provider !== null) {
              throw new ValidationError('Field "provider" must be a string or null');
            }
            if (rawBody.model !== undefined && typeof rawBody.model !== 'string' && rawBody.model !== null) {
              throw new ValidationError('Field "model" must be a string or null');
            }
            if (rawBody.reasoningEffort !== undefined && typeof rawBody.reasoningEffort !== 'string' && rawBody.reasoningEffort !== null) {
              throw new ValidationError('Field "reasoningEffort" must be a string or null');
            }
            if (rawBody.fallbackChain !== undefined && !Array.isArray(rawBody.fallbackChain) && rawBody.fallbackChain !== null) {
              throw new ValidationError('Field "fallbackChain" must be an array or null');
            }
            if (rawBody.clear !== undefined && typeof rawBody.clear !== 'boolean' && rawBody.clear !== null) {
              throw new ValidationError('Field "clear" must be a boolean or null');
            }

            let applyMode: "restart_all" | "save_only" = "restart_all";
            if (rawBody.applyMode !== undefined) {
              if (rawBody.applyMode !== "restart_all" && rawBody.applyMode !== "save_only") {
                throw new ValidationError('Field "applyMode" must be either "restart_all" or "save_only"');
              }
              applyMode = rawBody.applyMode;
            }

            const rawHeader = req.headers["if-match"];
            if (Array.isArray(rawHeader)) {
              throw new ValidationError('Multiple or duplicate "If-Match" headers are not allowed');
            }
            const ifMatchHeader = typeof rawHeader === 'string' ? rawHeader : undefined;

            let ifMatchBody: string | null | undefined = undefined;
            if (rawBody.ifMatch !== undefined) {
              if (typeof rawBody.ifMatch !== 'string' && rawBody.ifMatch !== null) {
                throw new ValidationError('Field "ifMatch" must be a string or null');
              }
              ifMatchBody = rawBody.ifMatch;
            }

            if (ifMatchHeader !== undefined && ifMatchBody !== undefined && ifMatchBody !== null) {
              const cleanHeader = ifMatchHeader.trim().replace(/^"|"$/g, '');
              const cleanBody = ifMatchBody.trim().replace(/^"|"$/g, '');
              if (cleanHeader !== cleanBody) {
                throw new ValidationError('Conflicting If-Match header and ifMatch body parameter');
              }
            }

            const ifMatch = ifMatchBody ?? ifMatchHeader;

            const updated = await cds.patchModelConfig(
              {
                provider: typeof rawBody.provider === 'string' ? rawBody.provider : (rawBody.provider === null ? null : undefined),
                model: typeof rawBody.model === 'string' ? rawBody.model : (rawBody.model === null ? null : undefined),
                reasoningEffort: typeof rawBody.reasoningEffort === 'string' ? rawBody.reasoningEffort : (rawBody.reasoningEffort === null ? null : undefined),
                fallbackChain: Array.isArray(rawBody.fallbackChain) ? rawBody.fallbackChain : undefined,
                clear: typeof rawBody.clear === 'boolean' ? rawBody.clear : undefined,
                applyMode,
                ifMatch,
              },
              user.id
            );

            // If save_only or no managementProvider, do not restart
            if (applyMode === "save_only") {
              updated.restartRequired = true;
              updated.restartStatus = "skipped";
              sendJsonResponse(res, 200, createSuccessEnvelope(updated));
              return;
            }

            if (!managementProvider || typeof managementProvider.restartRuntime !== "function") {
              updated.restartRequired = true;
              updated.restartStatus = "skipped";
              sendJsonResponse(res, 200, createSuccessEnvelope(updated));
              return;
            }

            // DB committed successfully; now trigger runtime restart
            try {
              const restartRes = await managementProvider.restartRuntime();
              const applied = restartRes.appliedRuntimes ?? (restartRes.restarted ? restartRes.userIds : []);
              const failed = restartRes.failedRuntimes ?? [];

              updated.appliedRuntimes = applied;
              updated.failedRuntimes = failed;

              if (failed.length > 0) {
                updated.restartRequired = true;
                updated.restartStatus = applied.length > 0 ? "partial" : "failed";

                // Audit partial / failed restart without sensitive data
                let auditOk = false;
                if (db) {
                  try {
                    db.prepare(`
                      INSERT INTO auth_audit_log (id, user_id, username, action, details, created_at)
                      VALUES (?, ?, NULL, 'model_config_updated', ?, CURRENT_TIMESTAMP)
                    `).run(
                      randomUUID(),
                      user.id,
                      JSON.stringify({
                        subAction: 'model_config_restart_partial',
                        appliedCount: applied.length,
                        failedCount: failed.length,
                        failedUsers: failed.map((f) => f.userId),
                      })
                    );
                    auditOk = true;
                  } catch (auditErr: unknown) {
                    auditOk = false;
                  }
                }
                updated.auditRecorded = auditOk;
              } else {
                updated.restartRequired = false;
                updated.restartStatus = "success";
                updated.auditRecorded = true;
              }

              sendJsonResponse(res, 200, createSuccessEnvelope(updated));
              return;
            } catch (restartErr: unknown) {
              const safeMsg = restartErr instanceof Error ? restartErr.message : "Runtime restart failed";
              updated.restartRequired = true;
              updated.restartStatus = "failed";
              updated.appliedRuntimes = [];
              updated.failedRuntimes = [{ userId: "*", error: safeMsg }];
              updated.auditRecorded = false;
              sendJsonResponse(res, 200, createSuccessEnvelope(updated));
              return;
            }
          }

          throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
        }

        // 8.12b Admin Models Health, Probing, Overrides, and Circuit Breakers
        if (adminSub === "/models/health") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const summaries = await modelSelectionService.getHealthSummaries();
          sendJsonResponse(res, 200, createSuccessEnvelope(summaries));
          return;
        }

        if (adminSub === "/models/overrides") {
          if (method !== "GET") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          const overrides = await modelSelectionService.listAllOverrides();
          sendJsonResponse(res, 200, createSuccessEnvelope(overrides));
          return;
        }

        if (adminSub === "/models/probe") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await parseJsonBody(req, maxBodyBytes);
          if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
            throw new ValidationError("Request body cannot be empty");
          }
          const unknownKeys = getUnknownKeys(rawBody, ALLOWED_MODEL_PROBE_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }
          if (typeof rawBody.provider !== "string" || !rawBody.provider.trim()) {
            throw new ValidationError('Field "provider" must be a non-empty string');
          }
          if (typeof rawBody.model !== "string" || !rawBody.model.trim()) {
            throw new ValidationError('Field "model" must be a non-empty string');
          }
          if (rawBody.mode !== undefined && rawBody.mode !== "list_models" && rawBody.mode !== "minimal_completion") {
            throw new ValidationError('Field "mode" must be either "list_models" or "minimal_completion"');
          }

          const result = await modelSelectionService.probeModel({
            provider: rawBody.provider,
            model: rawBody.model,
            mode: rawBody.mode as any,
          }, user.id);

          sendJsonResponse(res, 200, createSuccessEnvelope(result));
          return;
        }

        if (adminSub === "/models/circuit-breaker/reset") {
          if (method !== "POST") {
            throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
          }
          validateCsrf(req, { csrfToken });
          const rawBody = await parseJsonBody(req, maxBodyBytes);
          if (!isRecord(rawBody)) {
            throw new ValidationError("Request body must be an object");
          }
          const unknownKeys = getUnknownKeys(rawBody, ALLOWED_CIRCUIT_BREAKER_RESET_KEYS);
          if (unknownKeys.length > 0) {
            throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
          }
          const providerParam = typeof rawBody.provider === "string" ? rawBody.provider.trim() : undefined;
          const modelParam = typeof rawBody.model === "string" ? rawBody.model.trim() : undefined;

          const resetRes = await modelSelectionService.resetCircuitBreakers(providerParam, modelParam);
          sendJsonResponse(res, 200, createSuccessEnvelope(resetRes));
          return;
        }

        // 8.13 Storage: /api/admin/storage/* (Reconciliation, Repair, Baseline Scan)
        if (adminSub === "/storage" || adminSub.startsWith("/storage/")) {
          const storageSub = adminSub === "/storage" ? "" : adminSub.slice("/storage/".length);

          if (!db) {
            throw new PlatformError("Database service is unavailable", "SERVICE_UNAVAILABLE", 503);
          }

          const dualReconcile = new DualStorageReconcileService({ db });
          const volumeScan = new VolumeScanService({ db, operations });

          if (storageSub === "/reconcile" || storageSub === "reconcile") {
            if (method !== "GET") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            const targetUserId = parsedUrl.searchParams.get("userId") || user.id;
            const targetSessionId = parsedUrl.searchParams.get("sessionId");
            const dshPath = parsedUrl.searchParams.get("dshJsonlPath") || undefined;
            const dshDir = parsedUrl.searchParams.get("dshSessionsDir") || undefined;

            if (targetSessionId) {
              const report = await dualReconcile.reconcileSession(targetUserId, targetSessionId, dshPath);
              sendJsonResponse(res, 200, createSuccessEnvelope(report));
              return;
            }

            const allReport = await dualReconcile.reconcileAllSessions(targetUserId, dshDir);
            sendJsonResponse(res, 200, createSuccessEnvelope(allReport));
            return;
          }

          if (storageSub === "/repair" || storageSub === "repair") {
            if (method !== "POST") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, new Set(["userId", "sessionId", "dshJsonlPath", "dryRun"]));
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            const targetUserId = typeof body.userId === "string" ? validatePathId(body.userId, "userId") : user.id;
            if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
              throw new ValidationError('Field "sessionId" is required');
            }
            if (typeof body.dshJsonlPath !== "string" || !body.dshJsonlPath.trim()) {
              throw new ValidationError('Field "dshJsonlPath" is required');
            }

            const result = await dualReconcile.repairSession(
              targetUserId,
              body.sessionId as string,
              body.dshJsonlPath as string,
              { dryRun: Boolean(body.dryRun) }
            );
            sendJsonResponse(res, 200, createSuccessEnvelope(result));
            return;
          }

          if (storageSub === "/scan-baseline" || storageSub === "scan-baseline") {
            if (method !== "POST") {
              throw new PlatformError("Method Not Allowed", "METHOD_NOT_ALLOWED", 405);
            }
            validateCsrf(req, { csrfToken });
              const body = await parseJsonBody(req, maxBodyBytes);
            const unknownKeys = getUnknownKeys(body, new Set(["userId", "volumePath", "setBaseline"]));
            if (unknownKeys.length > 0) {
              throw new ValidationError(`Unexpected field "${unknownKeys[0]}"`);
            }

            const targetUserId = typeof body.userId === "string" ? validatePathId(body.userId, "userId") : user.id;
            if (typeof body.volumePath !== "string" || !body.volumePath.trim()) {
              throw new ValidationError('Field "volumePath" is required');
            }

            const result = await volumeScan.scanTenantVolumeBaseline(
              targetUserId,
              body.volumePath as string,
              { setBaseline: body.setBaseline !== false }
            );
            sendJsonResponse(res, 200, createSuccessEnvelope(result));
            return;
          }

          throw new NotFoundError(`Storage admin endpoint "${pathname}" not found`);
        }

        throw new NotFoundError(`Admin endpoint "${pathname}" not found`);
      }

      // 9. Static Assets & Web UI SPA fallback
      if (customWebUiHandler) {
        await customWebUiHandler(req, res);
        return;
      }

      if (method === "GET" || method === "HEAD") {
        if (pathname.startsWith("/static/")) {
          const assetName = pathname.slice("/static/".length);
          const asset = getWebUiAsset(assetName);
          if (asset && asset.exists) {
            res.statusCode = 200;
            res.setHeader("Content-Type", asset.contentType || "application/octet-stream");
            res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            if (method === "HEAD") {
              res.end();
              return;
            }
            res.end(asset.content);
            return;
          }
        }

        // Try direct asset if not "/" and not an API endpoint
        if (pathname !== "/" && pathname !== "/index.html" && !pathname.startsWith("/api/")) {
          const directName = pathname.startsWith("/") ? pathname.slice(1) : pathname;
          const asset = getWebUiAsset(directName);
          if (asset && asset.exists) {
            res.statusCode = 200;
            res.setHeader("Content-Type", asset.contentType || "application/octet-stream");
            res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            if (method === "HEAD") {
              res.end();
              return;
            }
            res.end(asset.content);
            return;
          }
        }

        // SPA HTML fallback for "/" or "/index.html" or client-side HTML routes
        if (!pathname.startsWith("/api/")) {
          const indexHtml = getWebUiIndexHtml();
          if (indexHtml) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("X-Frame-Options", "DENY");
            res.setHeader("Cache-Control", "no-cache, must-revalidate");
            if (method === "HEAD") {
              res.end();
              return;
            }
            res.end(indexHtml);
            return;
          }
        }
      }

      // Default API 404
      throw new NotFoundError(`Route ${method} ${pathname} not found`);
    } catch (err: unknown) {
      const { status, envelope } = mapErrorToResponse(err);
      sendJsonResponse(res, status, envelope);
    }
  };
}
