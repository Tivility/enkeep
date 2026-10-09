/**
 * WeChat Onboarding Job Service for Platform Server.
 *
 * Manages WeChat iLink QR onboarding state machine:
 * - Singleflight concurrency lock per user.
 * - QR code retrieval and status polling (handles need_verifycode, scaned_but_redirect, confirmed, expired).
 * - Automatic refresh for expired QR codes up to 3 times.
 * - On confirmed:
 *   - AES-256-GCM authenticated credential storage (bound to userId:credentialRef).
 *   - Upsert channel_accounts (type: 'wechat', status: 'active', defaultSpaceId: job.spaceId).
 *   - Trigger WeChatRuntimeManager.syncAccount to start long-polling poller.
 *   - If account with same bot already exists, updates credentials and space instead of duplicate creation.
 *
 * @module @enkeep/platform-server/channels/wechat-onboarding-service
 */

import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type PlatformStorage,
  type ChannelAccount,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '@enkeep/platform-core';
import {
  type OnboardingJobStatus,
  type OnboardingActionType,
  type OnboardingJobSummary,
} from '@enkeep/channel-lark';
import {
  startWeChatQrOnboarding,
  pollWeChatQrOnboarding,
  resolveWeChatRedirectBaseUrl,
  type WeChatQrStatus,
} from '@enkeep/channel-wechat';
import type { WeChatRuntimeManager } from './wechat-runtime.js';

export const WECHAT_QR_TTL_MS = 300_000; // 5 minutes
export const MAX_QR_REFRESH_COUNT = 3;

export interface CreateWeChatOnboardingJobOptions {
  readonly userId: string;
  readonly spaceId: string;
  readonly action: OnboardingActionType;
  readonly accountId?: string;
  readonly appName?: string;
  readonly fetchImpl?: typeof fetch;
  readonly customSessionTimeoutMs?: number;
}

interface ActiveWeChatOnboardingJob {
  readonly id: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly action: OnboardingActionType;
  accountId?: string;
  appName?: string;
  status: OnboardingJobStatus;
  statusMessage?: string;
  qrcode?: string;
  qrPayload?: string;
  qrUrl?: string;
  qrSvg?: string;
  qrDataUrl?: string;
  baseUrl?: string;
  verifyCode?: string;
  refreshCount: number;
  expiresAt: number;
  readonly createdAt: number;
  updatedAt: number;
  error?: string;
  requiresAttention?: boolean;
  lastPollAt?: number;
  abortController: AbortController;
  fetchImpl?: typeof fetch;
  inFlightPoll?: Promise<void>;
  configurationPromise?: Promise<void>;
}

export interface WeChatOnboardingServiceOptions {
  readonly storage: PlatformStorage;
  readonly db?: DatabaseSync;
  readonly runtimeManager?: WeChatRuntimeManager;
  readonly masterKey?: Buffer | string;
}

export class WeChatOnboardingService {
  private readonly storage: PlatformStorage;
  private readonly db?: DatabaseSync;
  private readonly runtimeManager?: WeChatRuntimeManager;
  private readonly masterKey: Buffer;
  private readonly jobs = new Map<string, ActiveWeChatOnboardingJob>(); // key: jobId
  private readonly userCreationLocks = new Map<string, Promise<void>>(); // key: userId

  constructor(options: WeChatOnboardingServiceOptions) {
    this.storage = options.storage;
    this.db = options.db;
    this.runtimeManager = options.runtimeManager;

    if (options.masterKey) {
      if (typeof options.masterKey === 'string') {
        if (/^[0-9a-fA-F]{64}$/.test(options.masterKey.trim())) {
          this.masterKey = Buffer.from(options.masterKey.trim(), 'hex');
        } else {
          this.masterKey = createHash('sha256').update(options.masterKey, 'utf8').digest();
        }
      } else if (Buffer.isBuffer(options.masterKey)) {
        this.masterKey = options.masterKey.length === 32
          ? options.masterKey
          : createHash('sha256').update(options.masterKey).digest();
      } else {
        this.masterKey = createHash('sha256').update('enkeep-channel-master-encryption-key-v1', 'utf8').digest();
      }
    } else {
      const envKey = process.env.ENKEEP_VAULT_KEY || process.env.ENKEEP_MASTER_KEY;
      if (envKey && envKey.trim().length > 0) {
        if (/^[0-9a-fA-F]{64}$/.test(envKey.trim())) {
          this.masterKey = Buffer.from(envKey.trim(), 'hex');
        } else {
          this.masterKey = createHash('sha256').update(envKey.trim(), 'utf8').digest();
        }
      } else {
        this.masterKey = createHash('sha256').update('enkeep-channel-master-encryption-key-v1', 'utf8').digest();
      }
    }
  }

  private pruneJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (
        job.status === 'ready' ||
        job.status === 'failed' ||
        job.status === 'cancelled' ||
        job.status === 'expired'
      ) {
        if (now - job.updatedAt > 15 * 60 * 1000) {
          this.jobs.delete(id);
        }
      } else if (job.expiresAt <= now && job.status === 'waiting_for_scan') {
        if (job.refreshCount < MAX_QR_REFRESH_COUNT) {
          // Attempt refresh on next poll
        } else {
          job.abortController.abort(new Error('Job expired'));
          job.status = 'expired';
          job.statusMessage = 'QR code expired';
          job.updatedAt = now;
        }
      }
    }
  }

  /**
   * Starts a new WeChat onboarding job (scan QR code to login iLink bot).
   * Enforces singleflight concurrency lock per user and verifies target space ownership.
   */
  async createJob(options: CreateWeChatOnboardingJobOptions): Promise<OnboardingJobSummary> {
    const {
      userId,
      spaceId,
      action,
      accountId,
      appName,
      fetchImpl = fetch,
      customSessionTimeoutMs = WECHAT_QR_TTL_MS,
    } = options;

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

      // 2. Validate action and accountId
      if (action === 'configure_existing' && accountId) {
        const tenant = this.storage.forTenant(userId);
        const acc = await tenant.channels.findAccountById(accountId);
        if (!acc) {
          throw new NotFoundError(`Specified account "${accountId}" not found for user`);
        }
        if (acc.type !== 'wechat') {
          throw new ValidationError(`Specified account "${accountId}" is not a WeChat channel account`);
        }
      }

      // 3. Singleflight concurrency check per user
      for (const job of this.jobs.values()) {
        if (
          job.userId === userId &&
          (job.status === 'waiting_for_scan' ||
            job.status === 'need_verifycode' ||
            job.status === 'configuring' ||
            job.status === 'verifying')
        ) {
          job.abortController.abort(new Error('Cancelled by new onboarding request'));
          job.status = 'cancelled';
          job.statusMessage = 'Superseded by new onboarding request';
          job.updatedAt = Date.now();
        }
      }

      // 4. Initialize WeChat QR code
      const jobId = `job_onb_wx_${randomUUID().replace(/-/g, '')}`;
      const now = Date.now();
      const expiresAt = now + customSessionTimeoutMs;
      const abortController = new AbortController();

      let qrStart;
      try {
        qrStart = await startWeChatQrOnboarding({
          fetchImpl,
          signal: abortController.signal,
        });
      } catch (err: any) {
        throw new ValidationError(`Failed to initialize WeChat QR login: ${err.message}`);
      }

      const job: ActiveWeChatOnboardingJob = {
        id: jobId,
        userId,
        spaceId,
        action,
        accountId: accountId?.trim(),
        appName: appName?.trim() || '微信助手',
        status: 'waiting_for_scan',
        statusMessage: '请使用微信扫描二维码',
        qrcode: qrStart.qrcode,
        qrPayload: qrStart.qrcodeImgContent || qrStart.qrcode,
        qrSvg: qrStart.qrSvg,
        qrDataUrl: qrStart.qrDataUrl,
        refreshCount: 0,
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
   * Retrieves status of a WeChat onboarding job.
   */
  async getJobStatus(userId: string, jobId: string): Promise<OnboardingJobSummary> {
    this.pruneJobs();

    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError(`Onboarding job "${jobId}" not found`);
    }

    if (
      job.status === 'waiting_for_scan' ||
      job.status === 'need_verifycode' ||
      job.status === 'configuring' ||
      job.status === 'verifying'
    ) {
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
   * Submits second-factor verification code for a WeChat onboarding job.
   */
  async submitVerifyCode(userId: string, jobId: string, verifyCode: string): Promise<OnboardingJobSummary> {
    this.pruneJobs();

    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError(`Onboarding job "${jobId}" not found`);
    }

    const trimmedCode = verifyCode.trim();
    if (!/^\d{1,12}$/.test(trimmedCode)) {
      throw new ValidationError('Verify code must be a numeric string between 1 and 12 digits');
    }

    if (job.status !== 'need_verifycode' && job.status !== 'waiting_for_scan') {
      throw new ValidationError(`Cannot submit verify code in status "${job.status}"`);
    }

    job.verifyCode = trimmedCode;
    job.statusMessage = 'Verification code submitted, checking status...';
    job.updatedAt = Date.now();

    // Trigger immediate poll with the submitted code
    await this.advanceOrVerifyJob(job);

    return this.toSummary(job);
  }

  /**
   * Cancels an active onboarding job.
   */
  async cancelJob(userId: string, jobId: string): Promise<OnboardingJobSummary> {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new NotFoundError(`Onboarding job "${jobId}" not found`);
    }

    job.abortController.abort(new Error('User cancelled onboarding'));
    job.status = 'cancelled';
    job.statusMessage = 'Onboarding job cancelled by user';
    job.updatedAt = Date.now();

    if (job.configurationPromise) {
      try {
        await job.configurationPromise;
      } catch {}
    }

    return this.toSummary(job);
  }

  private async advanceOrVerifyJob(job: ActiveWeChatOnboardingJob): Promise<void> {
    if (job.abortController.signal.aborted) return;

    if (job.status === 'waiting_for_scan' || job.status === 'need_verifycode') {
      await this.pollQrAndAdvance(job);
      return;
    }

    if (job.status === 'configuring') {
      return;
    }

    if (job.status === 'verifying') {
      if (!job.accountId) return;
      const tenant = this.storage.forTenant(job.userId);
      const account = await tenant.channels.findAccountById(job.accountId);
      if (!account || account.status !== 'active') return;

      if (this.runtimeManager) {
        try {
          await this.runtimeManager.syncAccount(job.userId, account.id);
          const gw = this.runtimeManager.getActiveGateway(job.userId, account.id);
          if (gw && gw.transport && gw.transport.connected) {
            job.status = 'ready';
            job.statusMessage = '微信渠道接入完成，连接已就绪！';
            job.updatedAt = Date.now();
          }
        } catch {}
      }
    }
  }

  private async pollQrAndAdvance(job: ActiveWeChatOnboardingJob): Promise<void> {
    if (!job.qrcode || job.abortController.signal.aborted) return;

    const now = Date.now();
    if (now > job.expiresAt) {
      if (job.refreshCount < MAX_QR_REFRESH_COUNT) {
        await this.refreshQr(job);
        return;
      } else {
        job.abortController.abort(new Error('Job expired'));
        job.status = 'expired';
        job.statusMessage = '二维码已过期';
        job.updatedAt = now;
        return;
      }
    }

    const fetcher = job.fetchImpl ?? fetch;

    try {
      const pollResult = await pollWeChatQrOnboarding(job.qrcode, {
        baseUrl: job.baseUrl,
        verifyCode: job.verifyCode,
        fetchImpl: fetcher,
        signal: job.abortController.signal,
      });

      job.lastPollAt = Date.now();

      switch (pollResult.status) {
        case 'wait':
          job.status = 'waiting_for_scan';
          job.statusMessage = '请使用微信扫描二维码';
          job.updatedAt = Date.now();
          break;

        case 'scaned':
          job.status = 'waiting_for_scan';
          job.statusMessage = '已扫码，请在手机微信上确认登录';
          job.updatedAt = Date.now();
          break;

        case 'scaned_but_redirect': {
          const redirectHost = pollResult.redirectHost;
          const resolvedBaseUrl = resolveWeChatRedirectBaseUrl(redirectHost);
          if (!resolvedBaseUrl) {
            job.status = 'failed';
            job.statusMessage = `非法重定向域名: ${redirectHost || 'unknown'}`;
            job.error = 'Invalid redirect host';
            job.updatedAt = Date.now();
            return;
          }
          job.baseUrl = resolvedBaseUrl;
          job.status = 'waiting_for_scan';
          job.statusMessage = '跨域重定向已就绪，正在继续确认...';
          job.updatedAt = Date.now();
          break;
        }

        case 'need_verifycode':
          job.status = 'need_verifycode';
          job.statusMessage = '微信要求输入短信或数字验证码';
          job.updatedAt = Date.now();
          break;

        case 'verify_code_blocked':
          job.status = 'failed';
          job.statusMessage = '验证码尝试次数过多被限制，请稍后重新扫码';
          job.error = 'Verify code blocked';
          job.updatedAt = Date.now();
          break;

        case 'binded_redirect':
        case 'confirmed': {
          if (!pollResult.botToken) {
            job.status = 'failed';
            job.statusMessage = '扫码确认成功但微信未返回 botToken';
            job.error = 'Missing bot_token in confirmed response';
            job.updatedAt = Date.now();
            return;
          }

          job.status = 'configuring';
          job.statusMessage = '扫码授权成功，正在保存凭据并创建微信渠道账号...';
          job.updatedAt = Date.now();

          this.ensureConfigurationStarted(job, pollResult);
          break;
        }

        case 'expired':
          if (job.refreshCount < MAX_QR_REFRESH_COUNT) {
            await this.refreshQr(job);
          } else {
            job.status = 'expired';
            job.statusMessage = '二维码已过期';
            job.updatedAt = Date.now();
          }
          break;
      }
    } catch (err: any) {
      if (job.abortController.signal.aborted) return;
      job.status = 'failed';
      job.statusMessage = `轮询微信状态失败: ${err.message}`;
      job.error = err.message;
      job.updatedAt = Date.now();
    }
  }

  private async refreshQr(job: ActiveWeChatOnboardingJob): Promise<void> {
    job.refreshCount++;
    const fetcher = job.fetchImpl ?? fetch;

    try {
      const qrStart = await startWeChatQrOnboarding({
        baseUrl: job.baseUrl,
        fetchImpl: fetcher,
        signal: job.abortController.signal,
      });

      job.qrcode = qrStart.qrcode;
      job.qrPayload = qrStart.qrcodeImgContent || qrStart.qrcode;
      job.qrSvg = qrStart.qrSvg;
      job.qrDataUrl = qrStart.qrDataUrl;
      job.expiresAt = Date.now() + WECHAT_QR_TTL_MS;
      job.status = 'waiting_for_scan';
      job.statusMessage = '二维码已刷新，请使用微信重新扫描';
      job.verifyCode = undefined;
      job.updatedAt = Date.now();
    } catch (err: any) {
      job.status = 'failed';
      job.statusMessage = `刷新二维码失败: ${err.message}`;
      job.error = err.message;
      job.updatedAt = Date.now();
    }
  }

  private ensureConfigurationStarted(
    job: ActiveWeChatOnboardingJob,
    pollResult: WeChatQrStatus
  ): Promise<void> {
    if (job.configurationPromise) {
      return job.configurationPromise;
    }

    const promise = (async () => {
      try {
        await this.executeConfiguration(job, pollResult);
      } catch (err: any) {
        if (!job.abortController.signal.aborted) {
          job.status = 'failed';
          job.statusMessage = `微信账号配置失败: ${err.message}`;
          job.error = err.message;
          job.updatedAt = Date.now();
        }
      }
    })();

    job.configurationPromise = promise;
    return promise;
  }

  /**
   * Executes credential encryption, account upsert, and runtime startup.
   */
  private async executeConfiguration(
    job: ActiveWeChatOnboardingJob,
    pollResult: WeChatQrStatus
  ): Promise<void> {
    const { botToken, ilinkBotId, baseUrl } = pollResult;
    if (!botToken) {
      throw new Error('Cannot execute configuration: botToken is missing');
    }

    const tenant = this.storage.forTenant(job.userId);
    const effectiveBotId = ilinkBotId || 'wechat_bot';

    // 1. Resolve or find existing account with this bot
    let targetAccount: ChannelAccount | null = null;
    if (job.accountId) {
      targetAccount = await tenant.channels.findAccountById(job.accountId);
    }

    if (!targetAccount) {
      const existingAccounts = await tenant.channels.listAccounts('wechat');
      for (const acc of existingAccounts) {
        if (acc.credentialRef) {
          const creds = await this.resolveCredentials(job.userId, acc.credentialRef);
          if (creds && creds.ilinkBotId === effectiveBotId) {
            targetAccount = acc;
            break;
          }
        }
      }
    }

    // 2. Encrypt and store credentials bound to userId and credentialRef
    const credentialRef = targetAccount?.credentialRef || `cred_wechat_${randomBytes(8).toString('hex')}`;
    const credentialPayload = {
      botToken,
      ilinkBotId: effectiveBotId,
      baseUrl: baseUrl || job.baseUrl || 'https://ilinkai.weixin.qq.com',
    };

    await this.storeEncryptedCredentials(job.userId, credentialRef, credentialPayload);

    // 3. Upsert channel_accounts
    if (!targetAccount) {
      targetAccount = await tenant.channels.createAccount({
        id: `acc_wechat_${randomBytes(8).toString('hex')}`,
        type: 'wechat',
        status: 'active',
        credentialRef,
        defaultSpaceId: job.spaceId,
      });
    } else {
      targetAccount = await tenant.channels.updateAccount(targetAccount.id, {
        status: 'active',
        credentialRef,
        defaultSpaceId: job.spaceId,
      });
    }

    job.accountId = targetAccount.id;

    // 4. Verify transport readiness with WeChatRuntimeManager
    job.status = 'verifying';
    job.statusMessage = '正在启动微信运行时长轮询...';
    job.updatedAt = Date.now();

    if (!this.runtimeManager) {
      job.status = 'verifying';
      job.statusMessage = '微信账号配置已完成，等待运行时管理器就绪...';
      job.updatedAt = Date.now();
      return;
    }

    let isConnected = false;
    try {
      await this.runtimeManager.syncAccount(job.userId, targetAccount.id);
      const gw = this.runtimeManager.getActiveGateway(job.userId, targetAccount.id);
      if (gw && gw.transport && gw.transport.connected) {
        isConnected = true;
      }
    } catch (e: any) {
      console.warn(`[wechat-onboarding] runtimeManager failed to sync account: ${e.message}`);
    }

    if (!isConnected) {
      job.status = 'verifying';
      job.statusMessage = '微信账号已创建，正在建立与微信服务器的长连接...';
    } else {
      job.status = 'ready';
      job.statusMessage = '微信渠道接入完成，连接已就绪！';
    }

    job.updatedAt = Date.now();
  }

  private async storeEncryptedCredentials(
    userId: string,
    credentialRef: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const iv = randomBytes(12);
    const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const encryptedPayload = `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;

    if (this.db) {
      const id = `enc_${randomBytes(8).toString('hex')}`;
      this.db
        .prepare(`
          INSERT INTO channel_encrypted_credentials (id, user_id, credential_ref, encrypted_payload, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(credential_ref) DO UPDATE SET
            encrypted_payload = excluded.encrypted_payload,
            updated_at = CURRENT_TIMESTAMP
        `)
        .run(id, userId, credentialRef, encryptedPayload);
    }
  }

  private async resolveCredentials(
    userId: string,
    credentialRef: string
  ): Promise<{ botToken?: string; ilinkBotId?: string } | null> {
    if (!this.db) return null;

    try {
      const row = this.db
        .prepare(`
          SELECT user_id, encrypted_payload FROM channel_encrypted_credentials
          WHERE credential_ref = ?
        `)
        .get(credentialRef) as { user_id: string; encrypted_payload: string } | undefined;

      if (!row || row.user_id !== userId) return null;
      const raw = row.encrypted_payload;

      if (raw.startsWith('{')) {
        return JSON.parse(raw);
      }

      if (raw.startsWith('v1:')) {
        const parts = raw.split(':');
        if (parts.length === 4) {
          const [, ivHex, tagHex, dataHex] = parts;
          const iv = Buffer.from(ivHex, 'hex');
          const tag = Buffer.from(tagHex, 'hex');
          const ciphertext = Buffer.from(dataHex, 'hex');
          const aad = Buffer.from(`${userId}:${credentialRef}`, 'utf8');

          const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
          decipher.setAAD(aad);
          decipher.setAuthTag(tag);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          return JSON.parse(decrypted.toString('utf8'));
        }
      }
    } catch {}
    return null;
  }

  private toSummary(job: ActiveWeChatOnboardingJob): OnboardingJobSummary {
    const isWaitingOrVerify = job.status === 'waiting_for_scan' || job.status === 'need_verifycode';
    const qrPayload = isWaitingOrVerify ? job.qrPayload : undefined;
    const qrUrl = isWaitingOrVerify ? job.qrUrl : undefined;
    const qrDataUrl = isWaitingOrVerify ? job.qrDataUrl : undefined;
    const qrSvg = isWaitingOrVerify ? job.qrSvg : undefined;

    return {
      id: job.id,
      userId: job.userId,
      spaceId: job.spaceId,
      action: job.action,
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
      error: job.error,
      requiresAttention: job.requiresAttention,
      accountId: job.accountId,
      lastPollAt: job.lastPollAt ? new Date(job.lastPollAt).toISOString() : undefined,
    };
  }
}
