import type {
  RuntimeMountReconciler,
  MountSourcePreflightContext,
  MountSourcePreflightResult,
  RuntimeMountSpec,
} from '@enkeep/platform-core';

export type PreflightSourceHandler = (
  sourcePath: string,
  context?: MountSourcePreflightContext
) => Promise<MountSourcePreflightResult>;

export type ReconcileUserMountsHandler = (
  userId: string,
  mode: 'host' | 'container',
  mountsBySpace: Record<string, RuntimeMountSpec[]>
) => Promise<void>;

export interface RuntimeMountReconcilerHandlers {
  readonly preflight: PreflightSourceHandler;
  readonly reconcile: ReconcileUserMountsHandler;
}

export class DefaultRuntimeMountReconciler implements RuntimeMountReconciler {
  constructor(
    private readonly handlers: {
      preflight: PreflightSourceHandler;
      reconcile: ReconcileUserMountsHandler;
    }
  ) {}

  async preflightSource(
    sourcePath: string,
    context?: MountSourcePreflightContext
  ): Promise<MountSourcePreflightResult> {
    return this.handlers.preflight(sourcePath, context);
  }

  async reconcileUserMounts(
    userId: string,
    mode: 'host' | 'container',
    mountsBySpace: Map<string, RuntimeMountSpec[]> | Record<string, RuntimeMountSpec[]>
  ): Promise<void> {
    const record: Record<string, RuntimeMountSpec[]> =
      mountsBySpace instanceof Map
        ? Object.fromEntries(mountsBySpace.entries())
        : mountsBySpace;
    return this.handlers.reconcile(userId, mode, record);
  }
}
