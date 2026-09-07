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
  'action',
  'spaceId',
  'accountId',
  'appId',
  'appName',
  'initialChatId',
  'brand',
]);

export class ChannelManagementService {
  private readonly storage: PlatformStorage;
  private readonly runtimeManager?: ChannelRuntimeManager;

  constructor(storage: PlatformStorage, runtimeManager?: ChannelRuntimeManager) {
    this.storage = storage;
    this.runtimeManager = runtimeManager;
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
      type: input.type,
      status: input.status,
      credentialRef: input.credentialRef,
      defaultSpaceId,
      groupActivationMode: input.groupActivationMode,
    });
    if (this.runtimeManager && created.status === 'active') {
      try {
        await this.runtimeManager.onAccountUpdated(userId, created.id);
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
    if (this.runtimeManager) {
      try {
        await this.runtimeManager.onAccountUpdated(userId, accountId);
      } catch {}
    }
    return updated;
  }

  async deleteAccount(userId: string, accountId: string): Promise<boolean> {
    const deleted = await this.storage.forTenant(userId).channels.deleteAccount(accountId);
    if (deleted && this.runtimeManager) {
      try {
        await this.runtimeManager.onAccountDeleted(userId, accountId);
      } catch {}
    }
    return deleted;
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
  private readonly expectedCsrfToken?: string;

  constructor(
    service: ChannelManagementService,
    expectedCsrfToken?: string,
    onboardingService?: LarkOnboardingService
  ) {
    this.service = service;
    this.expectedCsrfToken = expectedCsrfToken;
    this.onboardingService = onboardingService;
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
        if (!this.onboardingService) {
          throw new PlatformError('Onboarding service is not configured on this server');
        }

        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        assertStrictBodyShape(body, ALLOWED_ONBOARDING_JOB_CREATE_KEYS, 'Onboarding Job Creation payload');

        const action = validateExactString(body.action, 'action', true)!;
        if (action !== 'create_new' && action !== 'configure_existing') {
          throw new ValidationError(`Invalid action "${action}". Allowed: create_new, configure_existing.`);
        }

        const spaceId = validateExactString(body.spaceId, 'spaceId', true)!;
        const accountId = body.accountId !== undefined ? validateExactString(body.accountId, 'accountId') : undefined;
        const appId = body.appId !== undefined ? validateExactString(body.appId, 'appId') : undefined;
        const appName = body.appName !== undefined ? validateExactString(body.appName, 'appName') : undefined;
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

    // ──────────────── /api/manage/channels/onboarding/jobs/:id/cancel ────────────────
    const jobCancelMatch = pathname.match(/^\/api\/manage\/channels\/onboarding\/jobs\/([^/]+)\/cancel$/);
    if (jobCancelMatch) {
      const jobId = decodeURIComponent(jobCancelMatch[1]);
      if (method === 'POST') {
        if (this.expectedCsrfToken) {
          validateCsrf(req, { csrfToken: this.expectedCsrfToken });
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
