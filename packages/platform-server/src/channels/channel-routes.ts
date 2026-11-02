/**
 * Channel Management Service & API Routes for Platform Server.
 * Handles channel accounts, bindings, and status inspection without exposing raw credentials.
 * Includes Feishu/Lark Onboarding automation endpoints.
 *
 * @module @enkeep/platform-server/channels/channel-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  type User,
  type PlatformStorage,
  type ChannelAccount,
  type ChannelBinding,
  type CreateChannelAccountInput,
  type UpdateChannelAccountInput,
  type CreateChannelBindingInput,
  type UpdateChannelBindingInput,
} from '@enkeep/platform-core';
import { createSuccessEnvelope } from '@enkeep/protocol';
import {
  API_CACHE_CONTROL_HEADERS,
  validateCsrf,
} from '../safety/limits.js';
import { readJsonBody, sendJsonResponse, isRecord } from '../imports/happyclaw-migration-routes.js';
import { assertStrictBodyShape, validateExactString } from '../extensions/extension-routes.js';

import type { ChannelRuntimeManager } from './channel-runtime-manager.js';
import type { LarkOnboardingService } from './lark-onboarding-service.js';
import type { WeChatOnboardingService } from './wechat-onboarding-service.js';
import type { WeChatRuntimeManager } from './wechat-runtime.js';

export const ALLOWED_CHANNEL_ACCOUNT_CREATE_KEYS = Object.freeze([
  'type',
  'status',
  'credentialRef',
  'defaultSpaceId',
  'groupActivationMode',
]);

export const ALLOWED_CHANNEL_ACCOUNT_UPDATE_KEYS = Object.freeze([
  'status',
  'credentialRef',
  'defaultSpaceId',
  'groupActivationMode',
]);

export const ALLOWED_CHANNEL_BINDING_CREATE_KEYS = Object.freeze([
  'accountId',
  'spaceId',
  'nativeContextId',
  'activationMode',
]);

export const ALLOWED_CHANNEL_BINDING_UPDATE_KEYS = Object.freeze([
  'spaceId',
  'activationMode',
]);

export const ALLOWED_ONBOARDING_JOB_CREATE_KEYS = Object.freeze([
  'channel',
  'action',
  'spaceId',
  'accountId',
  'appId',
  'appName',
  'initialChatId',
  'brand',
]);

export const ALLOWED_ONBOARDING_JOB_VERIFY_KEYS = Object.freeze([
  'verifyCode',
]);

/**
 * Runtime side of one channel type, as seen by account management.
 * Every hook receives the owning user and the account id; failures are swallowed by the caller
 * (account data changes must not fail because a runtime could not be (re)started).
 */
export interface ChannelAccountLifecycle {
  /** Called after an active account was created. Defaults to `onAccountUpdated`. */
  onAccountCreated?(userId: string, accountId: string): Promise<unknown>;
  /** Called after an account was updated (status, credentials, default space...). */
  onAccountUpdated(userId: string, accountId: string): Promise<unknown>;
  /** Called after an account row was deleted. */
  onAccountDeleted(userId: string, accountId: string): Promise<unknown>;
  /** Explicit sync request (`POST /api/manage/channels/accounts/:id/sync`). */
  syncAccount(userId: string, accountId: string): Promise<unknown>;
}

/** Channel account types that always have a dedicated manager slot. */
export const BUILTIN_CHANNEL_ACCOUNT_TYPES = Object.freeze(['lark', 'wechat'] as const);

function larkLifecycle(manager: ChannelRuntimeManager): ChannelAccountLifecycle {
  return {
    onAccountCreated: (userId, accountId) => manager.onAccountUpdated(userId, accountId),
    onAccountUpdated: (userId, accountId) => manager.onAccountUpdated(userId, accountId),
    onAccountDeleted: (userId, accountId) => manager.onAccountDeleted(userId, accountId),
    syncAccount: (userId, accountId) => manager.syncAccount(userId, accountId),
  };
}

function wechatLifecycle(manager: WeChatRuntimeManager): ChannelAccountLifecycle {
  // The WeChat manager reconciles every change (create/update/delete) through syncAccount.
  return {
    onAccountCreated: (userId, accountId) => manager.syncAccount(userId, accountId),
    onAccountUpdated: (userId, accountId) => manager.syncAccount(userId, accountId),
    onAccountDeleted: (userId, accountId) => manager.syncAccount(userId, accountId),
    syncAccount: (userId, accountId) => manager.syncAccount(userId, accountId),
  };
}

export class ChannelManagementService {
  private readonly storage: PlatformStorage;
  private larkRuntimeManager?: ChannelRuntimeManager;
  private wechatManager?: WeChatRuntimeManager;
  /** Managers of non-builtin channel types (e.g. 'jarvis'), registered by the server wiring. */
  private readonly extraManagers = new Map<string, ChannelAccountLifecycle>();

  constructor(
    storage: PlatformStorage,
    runtimeManager?: ChannelRuntimeManager,
    wechatRuntimeManager?: WeChatRuntimeManager,
    extraManagers?: Readonly<Record<string, ChannelAccountLifecycle>>
  ) {
    this.storage = storage;
    this.larkRuntimeManager = runtimeManager;
    this.wechatManager = wechatRuntimeManager;
    if (extraManagers) {
      for (const [type, manager] of Object.entries(extraManagers)) {
        this.registerManager(type, manager);
      }
    }
  }

  /** Lark runtime manager (kept as a property for existing late-binding wiring). */
  get runtimeManager(): ChannelRuntimeManager | undefined {
    return this.larkRuntimeManager;
  }

  set runtimeManager(manager: ChannelRuntimeManager | undefined) {
    this.larkRuntimeManager = manager;
  }

  /** WeChat runtime manager (kept as a property for existing late-binding wiring). */
  get wechatRuntimeManager(): WeChatRuntimeManager | undefined {
    return this.wechatManager;
  }

  set wechatRuntimeManager(manager: WeChatRuntimeManager | undefined) {
    this.wechatManager = manager;
  }

  /**
   * Registers the runtime manager of a non-builtin channel type (for example `jarvis`).
   * Accounts of a type are only accepted once the type is builtin or registered.
   */
  registerManager(type: string, manager: ChannelAccountLifecycle): void {
    const normalized = typeof type === 'string' ? type.trim() : '';
    if (!normalized || !/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
      throw new ValidationError(`Invalid channel type "${String(type)}"`);
    }
    if ((BUILTIN_CHANNEL_ACCOUNT_TYPES as readonly string[]).includes(normalized)) {
      throw new ValidationError(`Channel type "${normalized}" is builtin and cannot be re-registered`);
    }
    this.extraManagers.set(normalized, manager);
  }

  unregisterManager(type: string): boolean {
    return this.extraManagers.delete(type);
  }

  /** Channel account types this server accepts: builtin types plus registered ones. */
  getSupportedTypes(): string[] {
    return [...BUILTIN_CHANNEL_ACCOUNT_TYPES, ...this.extraManagers.keys()];
  }

  isSupportedType(type: string | undefined | null): boolean {
    if (typeof type !== 'string') return false;
    return (BUILTIN_CHANNEL_ACCOUNT_TYPES as readonly string[]).includes(type) || this.extraManagers.has(type);
  }

  /**
   * Resolves the lifecycle of one channel type. Lark and WeChat each go to their own manager;
   * registered types go to their registered manager. Unknown types resolve to undefined and are
   * never handed to another channel's manager.
   */
  private lifecycleFor(type: string | undefined | null): ChannelAccountLifecycle | undefined {
    if (type === 'lark') {
      return this.larkRuntimeManager ? larkLifecycle(this.larkRuntimeManager) : undefined;
    }
    if (type === 'wechat') {
      return this.wechatManager ? wechatLifecycle(this.wechatManager) : undefined;
    }
    if (typeof type === 'string') {
      return this.extraManagers.get(type);
    }
    return undefined;
  }

  private assertSupportedType(type: string | undefined | null): void {
    if (!this.isSupportedType(type)) {
      throw new ValidationError(
        `Unsupported channel type "${String(type)}". Allowed: ${this.getSupportedTypes().join(', ')}.`
      );
    }
  }

  // ──────── Account Management ────────

  async listAccounts(userId: string, type?: string): Promise<ChannelAccount[]> {
    return this.storage.forTenant(userId).channels.listAccounts(type);
  }

  async getAccount(userId: string, accountId: string): Promise<ChannelAccount> {
    const account = await this.storage.forTenant(userId).channels.findAccountById(accountId);
    if (!account) {
      throw new NotFoundError(`Channel account "${accountId}" not found`);
    }
    return account;
  }

  async createAccount(
    userId: string,
    input: {
      type: string;
      status?: 'active' | 'disabled' | 'unverified';
      credentialRef?: string | null;
      defaultSpaceId?: string | null;
      groupActivationMode?: 'mention' | 'always';
    }
  ): Promise<ChannelAccount> {
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    this.assertSupportedType(type);

    let defaultSpaceId = input.defaultSpaceId;
    if (defaultSpaceId !== undefined && defaultSpaceId !== null) {
      const trimmed = typeof defaultSpaceId === 'string' ? defaultSpaceId.trim() : '';
      if (trimmed.length > 0) {
        const space = await this.storage.forTenant(userId).spaces.findById(trimmed);
        if (!space || space.status !== 'active') {
          throw new ValidationError(`Default workspace "${trimmed}" not found or is not active for this user`);
        }
        defaultSpaceId = trimmed;
      } else {
        defaultSpaceId = null;
      }
    }

    const created = await this.storage.forTenant(userId).channels.createAccount({
      type,
      status: input.status,
      credentialRef: input.credentialRef,
      defaultSpaceId,
      groupActivationMode: input.groupActivationMode,
    });
    if (created.status === 'active') {
      const lifecycle = this.lifecycleFor(created.type);
      try {
        if (lifecycle) {
          await (lifecycle.onAccountCreated ?? lifecycle.onAccountUpdated).call(lifecycle, userId, created.id);
        }
      } catch {}
    }
    return created;
  }

  async updateAccount(
    userId: string,
    accountId: string,
    input: UpdateChannelAccountInput
  ): Promise<ChannelAccount> {
    const updatePayload: UpdateChannelAccountInput = {
      status: input.status,
      credentialRef: input.credentialRef,
      groupActivationMode: input.groupActivationMode,
    };

    if (input.defaultSpaceId !== undefined) {
      if (input.defaultSpaceId !== null) {
        const trimmed = typeof input.defaultSpaceId === 'string' ? input.defaultSpaceId.trim() : '';
        if (trimmed.length > 0) {
          const space = await this.storage.forTenant(userId).spaces.findById(trimmed);
          if (!space || space.status !== 'active') {
            throw new ValidationError(`Default workspace "${trimmed}" not found or is not active for this user`);
          }
          updatePayload.defaultSpaceId = trimmed;
        } else {
          updatePayload.defaultSpaceId = null;
        }
      } else {
        updatePayload.defaultSpaceId = null;
      }
    }

    const updated = await this.storage.forTenant(userId).channels.updateAccount(accountId, updatePayload);
    if (input.groupActivationMode !== undefined) {
      await this.storage.forTenant(userId).channels.setGroupActivationModeForAccountBindings(accountId, input.groupActivationMode);
    }
    // Unknown (e.g. legacy imported) types stay editable but are never handed to another channel's runtime.
    const lifecycle = this.lifecycleFor(updated.type);
    try {
      if (lifecycle) {
        await lifecycle.onAccountUpdated(userId, accountId);
      }
    } catch {}
    return updated;
  }

  async deleteAccount(userId: string, accountId: string): Promise<boolean> {
    const existing = await this.storage.forTenant(userId).channels.findAccountById(accountId);
    const channelType = existing?.type;
    const deleted = await this.storage.forTenant(userId).channels.deleteAccount(accountId);
    if (deleted) {
      const lifecycle = this.lifecycleFor(channelType);
      try {
        if (lifecycle) {
          await lifecycle.onAccountDeleted(userId, accountId);
        }
      } catch {}
    }
    return deleted;
  }

  async syncAccount(userId: string, accountId: string): Promise<ChannelAccount> {
    const account = await this.getAccount(userId, accountId);
    this.assertSupportedType(account.type);
    const lifecycle = this.lifecycleFor(account.type);
    if (lifecycle) {
      await lifecycle.syncAccount(userId, accountId);
    }
    return account;
  }

  // ──────── Binding Management ────────

  async listBindings(userId: string, accountId?: string): Promise<ChannelBinding[]> {
    return this.storage.forTenant(userId).channels.listBindings(accountId);
  }

  async getBinding(userId: string, bindingId: string): Promise<ChannelBinding> {
    const binding = await this.storage.forTenant(userId).channels.findBindingById(bindingId);
    if (!binding) {
      throw new NotFoundError(`Channel binding "${bindingId}" not found`);
    }
    return binding;
  }

  async createBinding(
    userId: string,
    input: { accountId: string; spaceId: string; nativeContextId: string; activationMode?: 'mention' | 'always' }
  ): Promise<ChannelBinding> {
    return this.storage.forTenant(userId).channels.createBinding({
      accountId: input.accountId,
      spaceId: input.spaceId,
      nativeContextId: input.nativeContextId,
      activationMode: input.activationMode,
    });
  }

  async updateBinding(
    userId: string,
    bindingId: string,
    input: UpdateChannelBindingInput
  ): Promise<ChannelBinding> {
    return this.storage.forTenant(userId).channels.updateBinding(bindingId, input);
  }

  async deleteBinding(userId: string, bindingId: string): Promise<boolean> {
    return this.storage.forTenant(userId).channels.deleteBinding(bindingId);
  }
}

export class ChannelRoutes {
  private readonly service: ChannelManagementService;
  private readonly onboardingService?: LarkOnboardingService;
  private readonly wechatOnboardingService?: WeChatOnboardingService;
  private readonly expectedCsrfToken?: string;

  constructor(
    service: ChannelManagementService,
    expectedCsrfToken?: string,
    onboardingService?: LarkOnboardingService,
    wechatOnboardingService?: WeChatOnboardingService
  ) {
    this.service = service;
    this.expectedCsrfToken = expectedCsrfToken;
    this.onboardingService = onboardingService;
    this.wechatOnboardingService = wechatOnboardingService;
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    user: User
  ): Promise<boolean> {
    const method = (req.method || 'GET').toUpperCase();

    // ──────────────── /api/manage/channels/onboarding/jobs ────────────────
    if (pathname === '/api/manage/channels/onboarding/jobs') {
      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }

        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_ONBOARDING_JOB_CREATE_KEYS, 'Onboarding Job Creation payload');

        const channel = body.channel !== undefined ? validateExactString(body.channel, 'channel') : 'lark';
        if (channel !== 'lark' && channel !== 'wechat') {
          throw new ValidationError(`Invalid channel "${channel}". Allowed: lark, wechat.`);
        }

        const action = validateExactString(body.action, 'action', true)!;
        if (action !== 'create_new' && action !== 'configure_existing') {
          throw new ValidationError(`Invalid action "${action}". Allowed: create_new, configure_existing.`);
        }

        const spaceId = validateExactString(body.spaceId, 'spaceId', true)!;
        const accountId = body.accountId !== undefined ? validateExactString(body.accountId, 'accountId') : undefined;
        const appName = body.appName !== undefined ? validateExactString(body.appName, 'appName') : undefined;

        if (channel === 'wechat') {
          if (!this.wechatOnboardingService) {
            throw new PlatformError('WeChat onboarding service is not configured on this server');
          }

          const job = await this.wechatOnboardingService.createJob({
            userId: user.id,
            spaceId,
            action: action as any,
            accountId,
            appName,
          });

          sendJsonResponse(res, 201, createSuccessEnvelope(job));
          return true;
        }

        // Default Lark channel flow
        if (!this.onboardingService) {
          throw new PlatformError('Onboarding service is not configured on this server');
        }

        const appId = body.appId !== undefined ? validateExactString(body.appId, 'appId') : undefined;
        const initialChatId = body.initialChatId !== undefined ? validateExactString(body.initialChatId, 'initialChatId') : undefined;
        const brand = body.brand !== undefined ? validateExactString(body.brand, 'brand') : undefined;

        if (brand && brand !== 'feishu' && brand !== 'lark') {
          throw new ValidationError(`Invalid brand "${brand}". Allowed: feishu, lark.`);
        }

        const job = await this.onboardingService.createJob({
          userId: user.id,
          spaceId,
          action: action as any,
          accountId,
          appId,
          appName,
          initialChatId,
          brand: brand as any,
        });

        sendJsonResponse(res, 201, createSuccessEnvelope(job));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/onboarding/jobs/:id/verify ────────────────
    const jobVerifyMatch = pathname.match(/^\/api\/manage\/channels\/onboarding\/jobs\/([^/]+)\/verify$/);
    if (jobVerifyMatch) {
      const jobId = decodeURIComponent(jobVerifyMatch[1]);
      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        if (!this.wechatOnboardingService) {
          throw new PlatformError('WeChat onboarding service is not configured on this server');
        }

        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_ONBOARDING_JOB_VERIFY_KEYS, 'Onboarding Job Verify payload');

        const verifyCode = validateExactString(body.verifyCode, 'verifyCode', true)!;
        const job = await this.wechatOnboardingService.submitVerifyCode(user.id, jobId, verifyCode);
        sendJsonResponse(res, 200, createSuccessEnvelope(job));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/onboarding/jobs/:id/cancel ────────────────
    const jobCancelMatch = pathname.match(/^\/api\/manage\/channels\/onboarding\/jobs\/([^/]+)\/cancel$/);
    if (jobCancelMatch) {
      const jobId = decodeURIComponent(jobCancelMatch[1]);
      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }

        // Try wechat first if jobId has wx or wechat service exists
        if (this.wechatOnboardingService) {
          try {
            const job = await this.wechatOnboardingService.cancelJob(user.id, jobId);
            sendJsonResponse(res, 200, createSuccessEnvelope(job));
            return true;
          } catch (err) {
            if (!(err instanceof NotFoundError) || !this.onboardingService) {
              throw err;
            }
          }
        }

        if (!this.onboardingService) {
          throw new PlatformError('Onboarding service is not configured on this server');
        }

        const job = await this.onboardingService.cancelJob(user.id, jobId);
        sendJsonResponse(res, 200, createSuccessEnvelope(job));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/onboarding/jobs/:id ────────────────
    const jobMatch = pathname.match(/^\/api\/manage\/channels\/onboarding\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      if (method === 'GET') {
        if (this.wechatOnboardingService) {
          try {
            const job = await this.wechatOnboardingService.getJobStatus(user.id, jobId);
            sendJsonResponse(res, 200, createSuccessEnvelope(job));
            return true;
          } catch (err) {
            if (!(err instanceof NotFoundError) || !this.onboardingService) {
              throw err;
            }
          }
        }

        if (!this.onboardingService) {
          throw new PlatformError('Onboarding service is not configured on this server');
        }

        const job = await this.onboardingService.getJobStatus(user.id, jobId);
        sendJsonResponse(res, 200, createSuccessEnvelope(job));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/accounts ────────────────
    if (pathname === '/api/manage/channels/accounts') {
      if (method === 'GET') {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const type = url.searchParams.get('type') || undefined;
        const accounts = await this.service.listAccounts(user.id, type);
        sendJsonResponse(res, 200, createSuccessEnvelope({ accounts }));
        return true;
      }

      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_CHANNEL_ACCOUNT_CREATE_KEYS, 'Channel Account Creation payload');

        const type = validateExactString(body.type, 'type', true)!;
        const status = body.status !== undefined ? validateExactString(body.status, 'status') : undefined;
        const credentialRef = body.credentialRef !== undefined ? validateExactString(body.credentialRef, 'credentialRef') : undefined;
        const defaultSpaceId = body.defaultSpaceId === null || body.defaultSpaceId === ''
          ? null
          : (body.defaultSpaceId !== undefined ? validateExactString(body.defaultSpaceId, 'defaultSpaceId') : undefined);
        const groupActivationMode = body.groupActivationMode !== undefined ? validateExactString(body.groupActivationMode, 'groupActivationMode') : undefined;

        if (status && status !== 'active' && status !== 'disabled' && status !== 'unverified') {
          throw new ValidationError(`Invalid status "${status}". Allowed: active, disabled, unverified.`);
        }
        if (groupActivationMode !== undefined && groupActivationMode !== 'mention' && groupActivationMode !== 'always') {
          throw new ValidationError(`Invalid groupActivationMode "${groupActivationMode}". Allowed: mention, always.`);
        }

        const created = await this.service.createAccount(user.id, {
          type,
          status: status as any,
          credentialRef,
          defaultSpaceId,
          groupActivationMode: groupActivationMode as any,
        });

        sendJsonResponse(res, 201, createSuccessEnvelope(created));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/accounts/:id/sync ────────────────
    const accountSyncMatch = pathname.match(/^\/api\/manage\/channels\/accounts\/([^/]+)\/sync$/);
    if (accountSyncMatch) {
      const accountId = decodeURIComponent(accountSyncMatch[1]);
      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const account = await this.service.syncAccount(user.id, accountId);
        sendJsonResponse(res, 200, createSuccessEnvelope({ synced: true, account }));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/accounts/:id ────────────────
    const accountMatch = pathname.match(/^\/api\/manage\/channels\/accounts\/([^/]+)$/);
    if (accountMatch) {
      const accountId = decodeURIComponent(accountMatch[1]);

      if (method === 'GET') {
        const account = await this.service.getAccount(user.id, accountId);
        sendJsonResponse(res, 200, createSuccessEnvelope(account));
        return true;
      }

      if (method === 'PATCH' || method === 'PUT') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_CHANNEL_ACCOUNT_UPDATE_KEYS, 'Channel Account Update payload');

        const status = body.status !== undefined ? validateExactString(body.status, 'status') : undefined;
        const credentialRef = body.credentialRef !== undefined ? validateExactString(body.credentialRef, 'credentialRef') : undefined;
        const defaultSpaceId = body.defaultSpaceId === null || body.defaultSpaceId === ''
          ? null
          : (body.defaultSpaceId !== undefined ? validateExactString(body.defaultSpaceId, 'defaultSpaceId') : undefined);
        const groupActivationMode = body.groupActivationMode !== undefined ? validateExactString(body.groupActivationMode, 'groupActivationMode') : undefined;

        if (status && status !== 'active' && status !== 'disabled' && status !== 'unverified') {
          throw new ValidationError(`Invalid status "${status}". Allowed: active, disabled, unverified.`);
        }
        if (groupActivationMode !== undefined && groupActivationMode !== 'mention' && groupActivationMode !== 'always') {
          throw new ValidationError(`Invalid groupActivationMode "${groupActivationMode}". Allowed: mention, always.`);
        }

        const updated = await this.service.updateAccount(user.id, accountId, {
          status: status as any,
          credentialRef,
          defaultSpaceId,
          groupActivationMode: groupActivationMode as any,
        });
        sendJsonResponse(res, 200, createSuccessEnvelope(updated));
        return true;
      }

      if (method === 'DELETE') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const deleted = await this.service.deleteAccount(user.id, accountId);
        sendJsonResponse(res, 200, createSuccessEnvelope({ deleted }));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/bindings ────────────────
    if (pathname === '/api/manage/channels/bindings') {
      if (method === 'GET') {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const accountId = url.searchParams.get('accountId') || undefined;
        const bindings = await this.service.listBindings(user.id, accountId);
        sendJsonResponse(res, 200, createSuccessEnvelope({ bindings }));
        return true;
      }

      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_CHANNEL_BINDING_CREATE_KEYS, 'Channel Binding Creation payload');

        const accountId = validateExactString(body.accountId, 'accountId', true)!;
        const spaceId = validateExactString(body.spaceId, 'spaceId', true)!;
        const nativeContextId = validateExactString(body.nativeContextId, 'nativeContextId', true)!;
        const activationMode = body.activationMode !== undefined ? validateExactString(body.activationMode, 'activationMode') : undefined;

        if (activationMode && activationMode !== 'mention' && activationMode !== 'always') {
          throw new ValidationError(`Invalid activationMode "${activationMode}". Allowed: mention, always.`);
        }

        const created = await this.service.createBinding(user.id, {
          accountId,
          spaceId,
          nativeContextId,
          activationMode: activationMode as any,
        });

        sendJsonResponse(res, 201, createSuccessEnvelope(created));
        return true;
      }
    }

    // ──────────────── /api/manage/channels/bindings/:id ────────────────
    const bindingMatch = pathname.match(/^\/api\/manage\/channels\/bindings\/([^/]+)$/);
    if (bindingMatch) {
      const bindingId = decodeURIComponent(bindingMatch[1]);

      if (method === 'GET') {
        const binding = await this.service.getBinding(user.id, bindingId);
        sendJsonResponse(res, 200, createSuccessEnvelope(binding));
        return true;
      }

      if (method === 'PATCH' || method === 'PUT') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_CHANNEL_BINDING_UPDATE_KEYS, 'Channel Binding Update payload');

        const spaceId = body.spaceId !== undefined ? validateExactString(body.spaceId, 'spaceId') : undefined;
        const activationMode = body.activationMode !== undefined ? validateExactString(body.activationMode, 'activationMode') : undefined;

        if (activationMode && activationMode !== 'mention' && activationMode !== 'always') {
          throw new ValidationError(`Invalid activationMode "${activationMode}". Allowed: mention, always.`);
        }

        const updated = await this.service.updateBinding(user.id, bindingId, {
          spaceId,
          activationMode: activationMode as any,
        });
        sendJsonResponse(res, 200, createSuccessEnvelope(updated));
        return true;
      }

      if (method === 'DELETE') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
        }
        const deleted = await this.service.deleteBinding(user.id, bindingId);
        sendJsonResponse(res, 200, createSuccessEnvelope({ deleted }));
        return true;
      }
    }

    return false;
  }
}
