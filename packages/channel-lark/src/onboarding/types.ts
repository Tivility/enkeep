/**
 * Portions of this file are derived from botmux (https://github.com/botmux/botmux)
 * Copyright (c) 2026 botmux contributors
 * Licensed under the MIT License.
 *
 * Types and interfaces for Feishu/Lark Open Platform onboarding automation.
 *
 * @module @enkeep/channel-lark/onboarding/types
 */

export type OnboardingJobStatus =
  | 'waiting_for_scan'
  | 'configuring'
  | 'awaiting_approval'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type OnboardingActionType = 'create_new' | 'configure_existing';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expiresAt?: number;
  sameSite?: string;
}

export interface FeishuWebSessionIdentity {
  userId: string;
  userName: string;
  email?: string;
  tenantId: string;
  tenantName: string;
}

export interface ScopeManifest {
  scopes?: {
    tenant?: string[];
    user?: string[];
  };
}

export interface OpenPlatformScopeEntry {
  id: string;
  name: string;
  bucket?: 'tenant' | 'user';
}

export interface MappedScopeIds {
  tenantScopeIds: string[];
  userScopeIds: string[];
  missingTenantScopes: string[];
  missingUserScopes: string[];
}

export interface OpenPlatformPrivilegeField {
  id: string;
  name: string;
  selectStaff: boolean;
  supportsIn: boolean;
}

export interface OpenPlatformPrivilege {
  raw: Record<string, unknown>;
  bizId: string;
  resource: string;
  name: string;
  isRequired: boolean;
  fields: OpenPlatformPrivilegeField[];
  privilegeStatus?: string;
  content?: string;
}

export interface OpenPlatformPrivilegeState {
  privileges: OpenPlatformPrivilege[];
}

export interface OpenPlatformEventState {
  events: string[];
  eventMode?: number;
}

export interface OpenPlatformCallbackState {
  callbacks: string[];
  callbackMode?: number;
}

export interface OpenPlatformAutomationOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  sessionCookies: StoredCookie[];
  scopeManifest?: ScopeManifest;
  grantedScopeNames?: {
    tenant?: string[];
    user?: string[];
  };
  requireVerifiedEvents?: boolean;
  appJustCreated?: boolean;
  creatorUserId?: string;
  fetchImpl?: typeof fetch;
  onStatus?: (status: string) => Promise<void> | void;
}

export type OpenPlatformAutomationResult =
  | {
      ok: true;
      scopeCount: number;
      skippedScopeCount: number;
      scopeWarning?: string;
      privilegeRangeCount: number;
      privilegeRangeWarning?: string;
      subscribedEventCount: number;
      eventWarning?: string;
      eventModeReady?: boolean;
      redirectConfigured: boolean;
      redirectWarning?: string;
      versionId?: string;
      publishSkipped?: boolean;
      awaitingApproval?: boolean;
      approvalMessage?: string;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      subscribedEventCount?: number;
      eventWarning?: string;
      eventModeReady?: boolean;
      redirectConfigured: boolean;
      redirectWarning?: string;
      requiresAttention?: boolean;
    };

export interface CreateAppResult {
  appId: string;
  appSecret: string;
  versionId?: string;
  awaitingApproval?: boolean;
}

export interface OnboardingJobSummary {
  id: string;
  userId: string;
  spaceId: string;
  action: OnboardingActionType;
  appId?: string;
  appName?: string;
  status: OnboardingJobStatus;
  statusMessage?: string;
  qrPayload?: string;
  qrUrl?: string;
  qrDataUrl?: string;
  qrSvg?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  approvalRequired?: boolean;
  approvalMessage?: string;
  scopeCount?: number;
  subscribedEvents?: string[];
  error?: string;
  requiresAttention?: boolean;
  accountId?: string;
  lastPollAt?: string;
  statusCode?: number;
  nextStep?: string;
}
