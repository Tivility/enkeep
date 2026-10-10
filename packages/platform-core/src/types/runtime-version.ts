export interface RuntimeTargetVersionRecord {
  readonly id: string;
  readonly image: string | null;
  readonly daemonCliPath: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

export interface RuntimeVersionConfig {
  readonly image: string | null;
  readonly daemonCliPath: string | null;
}

export interface UserRuntimeUpgradeStatus {
  readonly userId: string;
  readonly mode: 'container' | 'host';
  readonly currentImage?: string | null;
  readonly currentDaemonCliPath?: string | null;
  readonly targetImage?: string | null;
  readonly targetDaemonCliPath?: string | null;
  readonly isOutdated: boolean;
  readonly isIdle: boolean;
  readonly idleDurationSeconds: number;
  readonly pendingReason?: 'idle' | 'busy' | 'threshold_not_met' | 'up_to_date' | 'paused' | string;
}
