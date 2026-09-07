/**
 * Runtime Container & Volume Specifications for Enkeep
 *
 * Defines the type contracts for isolated per-user DSH runtime containers,
 * dedicated volumes, controlled host mounts, ownership expectations, and zero-network safety constraints.
 *
 * @module @enkeep/runtime-runner/spec/types
 */

export type RuntimeUserId = 'alice' | 'bob' | (string & {});

export type RuntimeNetworkMode = 'none';

/**
 * Authoritative Controlled Mount Specification from platform.
 */
export interface RuntimeMountSpec {
  /** Unique stable mount identifier (e.g. 'mnt_0123456789abcdef') */
  readonly id: string;
  /** Strict slug name for model-facing path `/mnt/<name>` (must match ^[a-z0-9][a-z0-9_-]{0,63}$) */
  readonly name: string;
  /** Host source directory path (must be an existing absolute directory) */
  readonly sourcePath: string;
  /** Access mode: 'ro' (read-only) or 'rw' (read-write) */
  readonly mode: 'ro' | 'rw';
}

/**
 * Resolved Runtime Mount with physical in-container or in-host targetPath.
 */
export interface ResolvedRuntimeMount {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly mode: 'ro' | 'rw';
  readonly dev?: number;
  readonly ino?: number;
}

export interface RuntimeBindMountSpec {
  /** Host source path */
  sourcePath: string;
  /** Container destination path */
  containerPath: string;
  /** Whether the bind mount is read-only */
  readOnly?: boolean;
}

export interface RuntimeVolumeSpec {
  /** Docker volume name (must match ^enkeep-demo-dsh-[a-z0-9][a-z0-9_-]{0,60}$) */
  volumeName: string;
  /** Mandatory immutable unique volume identifier (must match ^vol_[0-9a-f]{32}$) */
  volumeId: string;
  /** Destination path inside the container (e.g. /home/dsh) */
  containerPath: string;
  /** Whether the volume is mounted read-only */
  readOnly?: boolean;
}

export interface RuntimeContainerSpec {
  /** Unique user identifier (e.g. 'alice', 'bob') */
  userId: RuntimeUserId;
  /** Mandatory random unique run identifier (must match ^run_[a-zA-Z0-9_-]{1,64}$) */
  runId: string;
  /** Container name (must match ^enkeep-demo-[a-z0-9][a-z0-9_-]{0,60}$) */
  containerName: string;
  /** Container image name (e.g. 'enkeep-demo-runtime:latest') */
  image: string;
  /** Non-root user ID / name inside container (must be '1000:1000') */
  user: string;
  /** Working directory inside container (must be '/home/dsh') */
  workingDir: string;
  /** Dedicated per-user Docker volume */
  volume: RuntimeVolumeSpec;
  /** Controlled host mounts */
  mounts?: RuntimeMountSpec[];
  /** Legacy bind mounts field (strictly forbidden if non-empty unless valid controlled mounts) */
  bindMounts?: RuntimeBindMountSpec[];
  /** Container network isolation mode (strictly 'none') */
  networkMode: RuntimeNetworkMode;
  /** Required container metadata labels (MUST include app: enkeep-demo, enkeep.user, enkeep.run-id, enkeep.volume-id) */
  labels: Record<string, string>;
  /** Container environment variables */
  environment: Record<string, string>;
}

export interface SpecValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ExactContainerIdentity {
  /** Full 64-hex container ID */
  containerId: string;
  /** Container name */
  containerName: string;
  /** Owner user ID */
  userId: string;
  /** Run ID */
  runId: string;
  /** Stable volume ID */
  volumeId: string;
}

export interface RunContainerResult {
  /** Full 64-hex container ID */
  containerId: string;
  /** Whether a new volume was created by this run call */
  volumeCreated: boolean;
}
