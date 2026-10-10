import type { DatabaseSync } from 'node:sqlite';
import type { ManagementRuntimeProvider, UserRuntimeStatus } from '../management/types.js';
import type { DeliveryRuntimeGateway } from './delivery-gateway.js';

export interface RuntimeAutoUpgraderOptions {
  db?: DatabaseSync;
  managementProvider?: ManagementRuntimeProvider;
  deliveryGateway?: DeliveryRuntimeGateway;
  checkIntervalSeconds?: number;
  idleThresholdSeconds?: number;
  enabled?: boolean;
}

export class RuntimeAutoUpgrader {
  private readonly db?: DatabaseSync;
  private readonly managementProvider?: ManagementRuntimeProvider;
  private readonly deliveryGateway?: DeliveryRuntimeGateway;
  private readonly checkIntervalSeconds: number;
  private readonly idleThresholdSeconds: number;
  private readonly enabled: boolean;

  private timer?: NodeJS.Timeout;
  private isChecking = false;
  private lastIdleTimestamps = new Map<string, number>();

  constructor(options: RuntimeAutoUpgraderOptions = {}) {
    this.db = options.db;
    this.managementProvider = options.managementProvider;
    this.deliveryGateway = options.deliveryGateway;

    const envEnabled = process.env.ENKEEP_RUNTIME_AUTO_UPGRADE;
    this.enabled = options.enabled !== undefined
      ? options.enabled
      : envEnabled !== '0' && envEnabled !== 'false';

    const envCheckSec = process.env.ENKEEP_RUNTIME_UPGRADE_CHECK_SECONDS;
    const parsedCheckSec = envCheckSec ? parseInt(envCheckSec, 10) : NaN;
    this.checkIntervalSeconds = options.checkIntervalSeconds ?? (
      Number.isSafeInteger(parsedCheckSec) && parsedCheckSec > 0 ? parsedCheckSec : 60
    );

    const envIdleSec = process.env.ENKEEP_RUNTIME_UPGRADE_IDLE_SECONDS;
    const parsedIdleSec = envIdleSec ? parseInt(envIdleSec, 10) : NaN;
    this.idleThresholdSeconds = options.idleThresholdSeconds ?? (
      Number.isSafeInteger(parsedIdleSec) && parsedIdleSec > 0 ? parsedIdleSec : 300
    );
  }

  public start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.checkAndUpgrade().catch(() => {});
    }, this.checkIntervalSeconds * 1000);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lastIdleTimestamps.clear();
  }

  public async checkAndUpgrade(): Promise<{ upgradedUserId?: string; status: string }> {
    if (this.isChecking || !this.enabled || !this.managementProvider) {
      return { status: 'skipped' };
    }
    this.isChecking = true;

    try {
      if (typeof this.managementProvider.getUpgradeStatus !== 'function') {
        return { status: 'no_upgrade_status_support' };
      }

      const statuses = await this.managementProvider.getUpgradeStatus();
      const now = Date.now();

      // Find candidates that are outdated
      const outdatedStatuses = statuses.filter((s) => s.isOutdated);
      if (outdatedStatuses.length === 0) {
        return { status: 'up_to_date' };
      }

      // Check idle time tracking
      let candidateToUpgrade: (typeof statuses)[0] | undefined;

      for (const item of outdatedStatuses) {
        // Query platform rounds count
        const rounds = this.deliveryGateway
          ? this.deliveryGateway.getUserActiveRoundsCount(item.userId)
          : { queued: 0, running: 0 };
        const isPlatformIdle = rounds.queued === 0 && rounds.running === 0;

        const isFullyIdle = item.isIdle && isPlatformIdle;

        if (!isFullyIdle) {
          this.lastIdleTimestamps.delete(item.userId);
          continue;
        }

        let firstIdleAt = this.lastIdleTimestamps.get(item.userId);
        if (!firstIdleAt) {
          firstIdleAt = now;
          this.lastIdleTimestamps.set(item.userId, firstIdleAt);
        }

        const idleElapsedSeconds = (now - firstIdleAt) / 1000;
        if (idleElapsedSeconds >= this.idleThresholdSeconds) {
          candidateToUpgrade = item;
          break; // Process at most 1 user per inspection run
        }
      }

      if (!candidateToUpgrade) {
        return { status: 'no_idle_candidate_meeting_threshold' };
      }

      const targetUserId = candidateToUpgrade.userId;

      // Step 1: Pause dispatch for this user (new messages enter held)
      if (this.deliveryGateway) {
        this.deliveryGateway.pauseUserDispatch(targetUserId);
      }

      try {
        // Step 2: Re-confirm idle status
        const recheckStatuses = await this.managementProvider.getUpgradeStatus();
        const currentTarget = recheckStatuses.find((s) => s.userId === targetUserId);
        const recheckRounds = this.deliveryGateway
          ? this.deliveryGateway.getUserActiveRoundsCount(targetUserId)
          : { queued: 0, running: 0 };
        const isStillPlatformIdle = recheckRounds.queued === 0 && recheckRounds.running === 0;

        if (!currentTarget || !currentTarget.isIdle || !isStillPlatformIdle) {
          // Busy! Abort and resume dispatch
          if (this.deliveryGateway) {
            this.deliveryGateway.resumeUserDispatch(targetUserId);
          }
          this.lastIdleTimestamps.delete(targetUserId);
          return { status: 'aborted_became_busy' };
        }

        // Step 3: Stop runtime (host stops daemon, container reconstructs on demand keeping volumes)
        if (typeof this.managementProvider.stopRuntime === 'function') {
          await this.managementProvider.stopRuntime(targetUserId, candidateToUpgrade.mode);
        }

        // Step 4: Resume dispatch & redrive held
        if (this.deliveryGateway) {
          this.deliveryGateway.resumeUserDispatch(targetUserId);
          await this.deliveryGateway.redriveHeld();
        }

        this.lastIdleTimestamps.delete(targetUserId);
        return { upgradedUserId: targetUserId, status: 'upgraded' };
      } catch (upgradeErr) {
        // Always ensure dispatch is resumed on error
        if (this.deliveryGateway) {
          this.deliveryGateway.resumeUserDispatch(targetUserId);
        }
        throw upgradeErr;
      }
    } finally {
      this.isChecking = false;
    }
  }
}
