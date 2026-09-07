/**
 * Feishu / Lark Onboarding Job Service for Platform Server.
 *
 * Manages QR login sessions, automation workflow, singleflight concurrency,
 * state transitions, timeout management, credential encryption, and channel provisioning.
 *
 * Real Invariants:
 * - Singleflight lock per job and per user reservation so concurrent calls never duplicate work.
 * - Exact account identification and verification via combined LarkCredentialResolver.
 * - Target Space is bound to account default space resolver (no fake `cli_*` chat bindings).
 * - When awaiting approval, account status is `unverified` (no auto-activation on startup).
 * - Status `ready` is ONLY reached when configuration is verified AND transport is genuinely connected.
 * - Read-only recovery verification for `verifying` and `awaiting_approval` without re-creating or re-publishing.
 * - AbortController passes through all operations for genuine cancellation.
 *
 * @module @enkeep/platform-server/channels/lark-onboarding-service
 */

import { randomUUID, randomBytes } from 'node:crypto';
import {
  type PlatformStorage,
  type ChannelAccount,
  type ChannelBinding,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '@enkeep/platform-core';
import {
  type OnboardingJobStatus,
  type OnboardingActionType,
  type OnboardingJobSummary,
  type StoredCookie,
  type LarkCredentialResolver,
  MutableCookieJar,
  initFeishuQrSession,
  pollFeishuQrSession,
  finalizeFeishuQrLogin,
  createFeishuBotApp,
  automateOpenPlatformSetup,
  createOpenPlatformApiClient,
  generateQrSvg,
  generateQrDataUrl,
} from '@enkeep/channel-lark';
import { LarkEncryptedCredentialStore } from './lark-encrypted-credentials.js';
import type { ChannelManagementService } from './channel-routes.js';
import type { ChannelRuntimeManager } from './channel-runtime-manager.js';

export interface CreateOnboardingJobOptions {
  userId: string;
  spaceId: string;
  action: OnboardingActionType;
  accountId?: string;
  appId?: string;
  appName?: string;
  initialChatId?: string;
  brand?: 'feishu' | 'lark';
  fetchImpl?: typeof fetch;
  customSessionTimeoutMs?: number;
}

interface ActiveOnboardingJob {
  readonly id: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly action: OnboardingActionType;
  accountId?: string;
  appId?: string;
  appName?: string;
  initialChatId?: string;
  readonly brand: 'feishu' | 'lark';
  status: OnboardingJobStatus;
  statusMessage?: string;
  flowKey?: string;
  token?: string;
  qrPayload?: string;
  qrUrl?: string;
  sessionJar?: MutableCookieJar;
  sessionCookies?: StoredCookie[];
  expiresAt: number;
  readonly createdAt: number;
  updatedAt: number;
  approvalRequired?: boolean;
  approvalMessage?: string;
  scopeCount?: number;
  error?: string;
  requiresAttention?: boolean;
  bindingId?: string;
  lastPollAt?: number;
  statusCode?: number;
  nextStep?: string;
  abortController: AbortController;
  fetchImpl?: typeof fetch;
  inFlightPoll?: Promise<void>;
  configurationPromise?: Promise<void>;
}

export class LarkOnboardingService {
  private readonly storage: PlatformStorage;
  private readonly credentialStore: LarkEncryptedCredentialStore;
  private readonly credentialResolver?: LarkCredentialResolver;
  private readonly channelService: ChannelManagementService;
  private readonly runtimeManager?: ChannelRuntimeManager;
  private readonly jobs = new Map<string, ActiveOnboardingJob>(); // key: jobId
  private readonly userCreationLocks = new Map<string, Promise<void>>(); // key: userId

  constructor(
    storage: PlatformStorage,
    credentialStore: LarkEncryptedCredentialStore,
    channelService: ChannelManagementService,
    runtimeManager?: ChannelRuntimeManager,
    credentialResolver?: LarkCredentialResolver
  ) {
    this.storage = storage;
    this.credentialStore = credentialStore;
    this.credentialResolver = credentialResolver;
    this.channelService = channelService;
    this.runtimeManager = runtimeManager;
  }

  /**
   * Resolves the default spaceId for an account configured during onboarding.
   */
  async resolveDefaultSpace(userId: string, account: ChannelAccount): Promise<string | undefined> {
    const live = await this.storage.forTenant(userId).channels.findAccountById(account.id);
    return live?.defaultSpaceId ?? undefined;
  }

  private pruneJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
        if (now - job.updatedAt > 15 * 60 * 1000) {
          this.jobs.delete(id);
        }
      } else if (job.expiresAt <= now) {
        job.abortController.abort(new Error('Job expired'));
        job.status = 'expired';
        job.statusMessage = 'Job expired';
        job.updatedAt = now;
        job.sessionCookies = undefined;
        job.sessionJar = undefined;
      }
    }
  }

  /**
   * Starts a new onboarding job (scan QR to create or configure existing bot).
   * Enforces user singleflight reservation lock, target space ownership, and explicit account verification.
   */
  async createJob(options: CreateOnboardingJobOptions): Promise<OnboardingJobSummary> {
    const { userId, spaceId, action, accountId, appId, appName, initialChatId, brand = 'feishu', fetchImpl = fetch } = options;

    // Await any in-flight creation lock for this user
    while (this.userCreationLocks.has(userId)) {
      await this.userCreationLocks.get(userId);
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.userCreationLocks.set(userId, lockPromise);

    try {
      this.pruneJobs();

      // 1. Verify Space ownership
      const space = await this.storage.forTenant(userId).spaces.findById(spaceId);
      if (!space) {
        throw new NotFoundError(`Target Space "${spaceId}" not found for user`);
      }

      // 2. Validate action and appId / accountId
      let verifiedAppId = appId?.trim();

      if (action === 'configure_existing') {
        if (accountId) {
          const tenant = this.storage.forTenant(userId);
          const acc = await tenant.channels.findAccountById(accountId);
          if (!acc) {
            throw new NotFoundError(`Specified account "${accountId}" not found for user`);
          }
          if (acc.credentialRef && this.credentialResolver) {
            const resolved = await this.credentialResolver.resolve(userId, acc.credentialRef);
            if (resolved) {
              if (verifiedAppId && resolved.appId !== verifiedAppId) {
                throw new ValidationError(
                  `Specified account "${accountId}" belongs to AppID "${resolved.appId}", which does not match requested AppID "${verifiedAppId}"`
                );
              }
              verifiedAppId = resolved.appId;
            }
          }
        }

        if (!verifiedAppId) {
          throw new ValidationError('AppID is required for configuring an existing bot');
        }
        if (!verifiedAppId.startsWith('cli_')) {
          throw new ValidationError('AppID must be a valid Feishu app ID starting with "cli_"');
        }
      }

      // 3. Singleflight concurrency check per user / app
      for (const job of this.jobs.values()) {
        if (
          job.userId === userId &&
          (job.status === 'waiting_for_scan' || job.status === 'configuring' || job.status === 'verifying')
        ) {
          if (action === 'configure_existing' && job.appId === verifiedAppId) {
            throw new ConflictError(`An onboarding job is already active for AppID "${verifiedAppId}"`);
          }
          // Abort previous active job for this user
          job.abortController.abort(new Error('Cancelled by new onboarding request'));
          job.status = 'cancelled';
          job.statusMessage = 'Superseeded by new onboarding request';
          job.sessionCookies = undefined;
          job.sessionJar = undefined;
          job.updatedAt = Date.now();
        }
      }

      // 4. Initialize QR Session
      const jobId = `job_onb_${randomUUID().replace(/-/g, '')}`;
      const timeoutMs = options.customSessionTimeoutMs ?? 5 * 60 * 1000; // 5 mins
      const now = Date.now();
      const expiresAt = now + timeoutMs;
      const sessionJar = new MutableCookieJar([]);
      const abortController = new AbortController();

      let qrInit: { flowKey: string; token: string; qrPayload: string; qrUrl?: string };
      try {
        qrInit = await initFeishuQrSession(sessionJar, fetchImpl, abortController.signal);
      } catch (err: any) {
        throw new ValidationError(`Failed to initialize Feishu QR login: ${err.message}`);
      }

      const qrSvg = generateQrSvg(qrInit.qrPayload);
      const qrDataUrl = generateQrDataUrl(qrInit.qrPayload);

      const job: ActiveOnboardingJob = {
        id: jobId,
        userId,
        spaceId,
        action,
        accountId: accountId?.trim(),
        appId: verifiedAppId,
        appName: appName?.trim() || (action === 'create_new' ? 'Enkeep Bot' : undefined),
        initialChatId: initialChatId?.trim(),
        brand,
        status: 'waiting_for_scan',
        statusMessage: 'Waiting for Feishu mobile app scan',
        flowKey: qrInit.flowKey,
        token: qrInit.token,
        qrPayload: qrInit.qrPayload,
        qrUrl: qrInit.qrUrl,
        sessionJar,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        abortController,
        fetchImpl,
      };

      this.jobs.set(jobId, job);
      return this.toSummary(job);
    } finally {
      this.userCreationLocks.delete(userId);
      resolveLock();
    }
  }

  /**
   * Retrieves current status of an onboarding job with singleflight execution and read-only verification for pending states.
   */
  async getJobStatus(userId: string, jobId: string): Promise<OnboardingJobSummary> {
    this.pruneJobs();

    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError(`Onboarding job "${jobId}" not found`);
    }

    if (job.status === 'waiting_for_scan' || job.status === 'configuring' || job.status === 'verifying' || job.status === 'awaiting_approval') {
      if (job.inFlightPoll) {
        await job.inFlightPoll;
      } else {
        const pollPromise = this.advanceOrVerifyJob(job);
        job.inFlightPoll = pollPromise;
        try {
          await pollPromise;
        } finally {
          job.inFlightPoll = undefined;
        }
      }
    }

    return this.toSummary(job);
  }

  /**
   * Internal step: handles QR polling when in waiting_for_scan, or read-only transport verification when verifying / awaiting_approval.
   */
  private async advanceOrVerifyJob(job: ActiveOnboardingJob): Promise<void> {
    if (job.abortController.signal.aborted) return;

    if (job.status === 'waiting_for_scan') {
      await this.pollQrAndAdvance(job);
      return;
    }

    if (job.status === 'configuring') {
      // Tracked background configuration is executing via configurationPromise.
      // Do NOT re-execute or duplicate publish; return immediately so caller sees configuring.
      return;
    }

    // Read-only recovery / verification for verifying state (NO re-create, NO re-publish)
    if (job.status === 'verifying') {
      if (!job.accountId) return;

      const tenant = this.storage.forTenant(job.userId);
      const account = await tenant.channels.findAccountById(job.accountId);
      if (!account || account.status !== 'active') return;

      if (this.runtimeManager) {
        try {
          await this.runtimeManager.onAccountUpdated(job.userId, account.id);
          const gw = this.runtimeManager.getActiveGateway(job.userId, account.id);
          if (gw && gw.transport && gw.transport.connected) {
            job.status = 'ready';
            job.statusMessage = job.initialChatId
              ? 'Bot onboarding complete, channel active and chat bound!'
              : 'Bot onboarding complete and channel active! Waiting for first chat interaction in Feishu.';
            job.updatedAt = Date.now();
          }
        } catch {}
      }
    }
  }

  /**
   * Internal step: polls QR status and advances state.
   */
  private async pollQrAndAdvance(job: ActiveOnboardingJob): Promise<void> {
    if (job.status !== 'waiting_for_scan' || !job.flowKey || !job.sessionJar || job.abortController.signal.aborted) {
      return;
    }

    if (Date.now() > job.expiresAt) {
      job.abortController.abort(new Error('Job expired'));
      job.status = 'expired';
      job.statusMessage = 'QR code expired';
      job.token = undefined;
      job.qrPayload = undefined;
      job.qrUrl = undefined;
      job.sessionCookies = undefined;
      job.sessionJar = undefined;
      job.updatedAt = Date.now();
      return;
    }

    const fetcher = job.fetchImpl ?? fetch;

    try {
      const poll = await pollFeishuQrSession(job.sessionJar, job.flowKey, fetcher, job.abortController.signal);
      job.lastPollAt = Date.now();
      job.statusCode = poll.status ?? undefined;
      job.nextStep = poll.nextStep ?? undefined;

      if (poll.isExpired) {
        job.abortController.abort(new Error('QR expired'));
        job.status = 'expired';
        job.statusMessage = 'QR code expired';
        job.token = undefined;
        job.qrPayload = undefined;
        job.qrUrl = undefined;
        job.sessionCookies = undefined;
        job.sessionJar = undefined;
        job.updatedAt = Date.now();
        return;
      }

      if (poll.isConfirmed) {
        job.statusMessage = 'Scanned, waiting for mobile authorization confirmation';
        job.updatedAt = Date.now();
      }

      if (poll.isComplete) {
        if (job.abortController.signal.aborted) return;

        job.status = 'configuring';
        job.statusMessage = 'QR scan authorized, configuring Open Platform application...';
        job.token = undefined;
        job.qrPayload = undefined;
        job.qrUrl = undefined;
        job.updatedAt = Date.now();

        // Start tracked configuration in background; GET returns 'configuring' immediately without blocking.
        this.ensureConfigurationStarted(job, poll.crossLoginUri, fetcher);
        return;
      }
    } catch (err: any) {
      if (job.abortController.signal.aborted) return;
      job.lastPollAt = Date.now();
      job.status = 'failed';
      job.statusMessage = `QR polling failed: ${err.message}`;
      job.error = err.message;
      job.token = undefined;
      job.qrPayload = undefined;
      job.qrUrl = undefined;
      job.sessionCookies = undefined;
      job.sessionJar = undefined;
      job.updatedAt = Date.now();
    }
  }

  /**
   * Tracks and initiates background configuration execution exactly once per job.
   * Runs finalizing and configuration asynchronously without blocking the GET response.
   */
  private ensureConfigurationStarted(
    job: ActiveOnboardingJob,
    crossLoginUri: string | null,
    fetcher: typeof fetch
  ): Promise<void> {
    if (job.configurationPromise) {
      return job.configurationPromise;
    }

    const sessionJar = job.sessionJar;
    const promise = (async () => {
      try {
        if (sessionJar) {
          const cookies = await finalizeFeishuQrLogin(
            sessionJar,
            crossLoginUri,
            fetcher,
            job.abortController.signal
          );
          job.sessionCookies = cookies;
          job.sessionJar = undefined;
        }

        if (job.abortController.signal.aborted) return;
        await this.executeConfiguration(job);
      } catch (err: any) {
        if (!job.abortController.signal.aborted) {
          job.status = 'failed';
          job.statusMessage = `Configuration failed: ${err.message}`;
          job.error = err.message;
          job.sessionCookies = undefined;
          job.sessionJar = undefined;
          job.updatedAt = Date.now();
        }
      }
    })();

    job.configurationPromise = promise;
    return promise;
  }

  /**
   * Executes the configuration and provisioning pipeline.
   */
  private async executeConfiguration(job: ActiveOnboardingJob): Promise<void> {
    if (!job.sessionCookies || job.sessionCookies.length === 0 || job.abortController.signal.aborted) {
      if (!job.abortController.signal.aborted) {
        job.status = 'failed';
        job.statusMessage = 'No valid session cookies obtained after QR login';
        job.updatedAt = Date.now();
      }
      return;
    }

    const fetcher = job.fetchImpl ?? fetch;
    const signal = job.abortController.signal;

    try {
      let targetAppId = job.appId;
      let targetAppSecret: string | undefined;
      let awaitingApproval = false;
      let approvalMessage: string | undefined;
      let versionId: string | undefined;

      if (job.action === 'create_new') {
        job.statusMessage = 'Creating new Feishu bot application...';
        const createResult = await createFeishuBotApp(job.sessionCookies, {
          name: job.appName || 'Enkeep Assistant Bot',
          fetchImpl: fetcher,
          signal,
        });

        if (signal.aborted) return;

        targetAppId = createResult.appId;
        targetAppSecret = createResult.appSecret;
        versionId = createResult.versionId;
        awaitingApproval = createResult.awaitingApproval ?? false;
        job.appId = targetAppId;
      }

      if (!targetAppId) {
        throw new Error('Target AppID is undefined');
      }

      if (signal.aborted) return;

      // Automate Open Platform Scopes, Events, and Publish
      job.statusMessage = 'Configuring permissions, events, and long-connection mode...';
      const autoResult = await automateOpenPlatformSetup({
        appId: targetAppId,
        brand: job.brand,
        sessionCookies: job.sessionCookies,
        requireVerifiedEvents: true,
        appJustCreated: job.action === 'create_new',
        fetchImpl: fetcher,
        signal,
      });

      if (signal.aborted) return;

      if (!autoResult.ok) {
        job.status = 'failed';
        job.statusMessage = `Configuration failed: ${autoResult.message}`;
        job.error = autoResult.message;
        job.requiresAttention = autoResult.requiresAttention;
        job.updatedAt = Date.now();
        job.sessionCookies = undefined;
        job.sessionJar = undefined;
        return;
      }

      job.scopeCount = autoResult.scopeCount;
      if (autoResult.awaitingApproval) {
        awaitingApproval = true;
        approvalMessage = autoResult.approvalMessage || 'Version submitted for administrator approval';
      }

      // Read AppSecret for existing bot if not already known (POST /developers/v1/secret/:clientId)
      if (!targetAppSecret) {
        const { client } = await createOpenPlatformApiClient(job.sessionCookies, targetAppId, fetcher, signal);
        targetAppSecret = await client.postJson(`/developers/v1/secret/${targetAppId}`, {}, signal)
          .then((res: any) => {
            const root = res?.data ?? res;
            return root?.secret ?? root?.appSecret ?? root?.app_secret;
          });
      }

      if (!targetAppSecret) {
        throw new Error('Failed to retrieve AppSecret from Open Platform (unknown response, will not retry)');
      }

      if (signal.aborted) return;

      // 4. Store encrypted credentials (AES-256-GCM, tenant+ref bound)
      job.status = 'verifying';
      job.statusMessage = 'Provisioning encrypted credentials and verifying connection...';
      job.updatedAt = Date.now();

      const credentialRef = await this.credentialStore.storeCredentials(job.userId, {
        appId: targetAppId,
        appSecret: targetAppSecret,
        domain: job.brand,
      });

      if (signal.aborted) {
        await this.credentialStore.deleteCredentials(job.userId, credentialRef);
        return;
      }

      // 5. Account Resolution & Provisioning
      const tenant = this.storage.forTenant(job.userId);
      let account: ChannelAccount | null = null;

      if (job.accountId) {
        account = await tenant.channels.findAccountById(job.accountId);
      }

      if (!account) {
        const existingAccounts = await tenant.channels.listAccounts('lark');
        for (const acc of existingAccounts) {
          if (acc.credentialRef) {
            const resolver = this.credentialResolver ?? this.credentialStore;
            const resolved = await resolver.resolve(job.userId, acc.credentialRef);
            if (resolved && resolved.appId === targetAppId) {
              account = acc;
              break;
            }
          }
        }
      }

      // If awaiting approval, account status MUST BE unverified (not active)
      const targetAccountStatus = awaitingApproval ? 'unverified' : 'active';

      if (!account) {
        account = await tenant.channels.createAccount({
          id: `acc_lark_${randomBytes(8).toString('hex')}`,
          type: 'lark',
          status: targetAccountStatus,
          credentialRef,
          defaultSpaceId: job.spaceId,
        });
      } else {
        account = await tenant.channels.updateAccount(account.id, {
          status: targetAccountStatus,
          credentialRef,
          defaultSpaceId: job.spaceId,
        });
      }
      job.accountId = account.id;

      if (signal.aborted) return;

      // 6. Bind explicit initialChatId if provided
      if (job.initialChatId) {
        const existingBindings = await tenant.channels.listBindings(account.id);
        let binding = existingBindings.find((b) => b.nativeContextId === job.initialChatId);
        if (!binding) {
          binding = await tenant.channels.createBinding({
            accountId: account.id,
            spaceId: job.spaceId,
            nativeContextId: job.initialChatId,
            activationMode: 'mention',
          });
        }
        job.bindingId = binding.id;
      }

      // 7. Verify Transport Readiness
      if (awaitingApproval) {
        job.status = 'awaiting_approval';
        job.statusMessage = approvalMessage || 'Configuration complete. Pending administrator approval in Feishu Console.';
        job.approvalRequired = true;
        job.approvalMessage = approvalMessage;
      } else {
        // Without runtimeManager OR if transport is not connected, state MUST NOT be ready
        if (!this.runtimeManager) {
          job.status = 'verifying';
          job.statusMessage = 'Configuration completed; runtime manager is not running. Channel will activate upon runtime manager startup.';
        } else {
          let isConnected = false;
          try {
            await this.runtimeManager.onAccountUpdated(job.userId, account.id);
            const gw = this.runtimeManager.getActiveGateway(job.userId, account.id);
            if (gw && gw.transport && gw.transport.connected) {
              isConnected = true;
            }
          } catch (e: any) {
            console.warn(`Runtime manager failed to activate gateway: ${e.message}`);
          }

          if (!isConnected) {
            job.status = 'verifying';
            job.statusMessage = 'Configuration published, waiting for Lark long connection to become online...';
          } else {
            job.status = 'ready';
            job.statusMessage = job.initialChatId
              ? 'Bot onboarding complete, channel active and chat bound!'
              : 'Bot onboarding complete and channel active! Waiting for first chat interaction in Feishu.';
          }
        }
      }

      job.updatedAt = Date.now();
    } catch (err: any) {
      if (signal.aborted) return;
      job.status = 'failed';
      job.statusMessage = `Onboarding execution error: ${err.message}`;
      job.error = err.message;
      job.updatedAt = Date.now();
    } finally {
      job.sessionCookies = undefined;
      job.sessionJar = undefined;
    }
  }

  /**
   * Cancels an active onboarding job and aborts in-flight requests.
   */
  async cancelJob(userId: string, jobId: string): Promise<OnboardingJobSummary> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError(`Onboarding job "${jobId}" not found`);
    }

    job.abortController.abort(new Error('User cancelled onboarding'));
    job.status = 'cancelled';
    job.statusMessage = 'Onboarding job cancelled by user';
    job.token = undefined;
    job.qrPayload = undefined;
    job.qrUrl = undefined;
    job.sessionCookies = undefined;
    job.sessionJar = undefined;
    job.updatedAt = Date.now();

    if (job.configurationPromise) {
      try {
        await job.configurationPromise;
      } catch {}
    }

    return this.toSummary(job);
  }

  private toSummary(job: ActiveOnboardingJob): OnboardingJobSummary {
    const isWaitingForScan = job.status === 'waiting_for_scan';
    const qrPayload = isWaitingForScan ? job.qrPayload : undefined;
    const qrUrl = isWaitingForScan ? job.qrUrl : undefined;
    const qrDataUrl = (isWaitingForScan && job.qrPayload) ? generateQrDataUrl(job.qrPayload) : undefined;
    const qrSvg = (isWaitingForScan && job.qrPayload) ? generateQrSvg(job.qrPayload) : undefined;

    return {
      id: job.id,
      userId: job.userId,
      spaceId: job.spaceId,
      action: job.action,
      appId: job.appId,
      appName: job.appName,
      status: job.status,
      statusMessage: job.statusMessage,
      qrPayload,
      qrUrl,
      qrDataUrl,
      qrSvg,
      expiresAt: new Date(job.expiresAt).toISOString(),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      approvalRequired: job.approvalRequired,
      approvalMessage: job.approvalMessage,
      scopeCount: job.scopeCount,
      error: job.error,
      requiresAttention: job.requiresAttention,
      accountId: job.accountId,
      lastPollAt: job.lastPollAt ? new Date(job.lastPollAt).toISOString() : undefined,
      statusCode: job.statusCode,
      nextStep: job.nextStep,
    };
  }
}
