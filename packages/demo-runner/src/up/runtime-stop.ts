/**
 * Stops a user's runtimes for the management provider.
 *
 * The demo registers one management provider for both execution modes. A mode-scoped stop
 * (the idle auto-upgrader rebuilding an outdated container, or replacing a host daemon) must only
 * stop that mode: the user's other runtime may be running background tasks the idle check of the
 * stopped mode never looked at. Without a mode (explicit "stop runtime"), both are stopped.
 */

export type RuntimeStopMode = 'container' | 'host';

export interface StoppableRuntimeHandle {
  stop(): Promise<void>;
  teardown(removeVolume?: boolean): Promise<void>;
  rawHandle?: unknown;
}

export interface RuntimeHandleMaps<H extends StoppableRuntimeHandle> {
  readonly hostRuntimeHandles: Map<string, H>;
  readonly runtimeHandles: Map<string, H>;
}

export interface RuntimeStopResult {
  readonly stopped: boolean;
  readonly stoppedModes: RuntimeStopMode[];
  readonly normalizedUserId: string;
}

export async function stopUserRuntimeHandles<H extends StoppableRuntimeHandle>(
  maps: RuntimeHandleMaps<H>,
  targetUserId: string,
  mode?: RuntimeStopMode,
  log: (message: string, data: Record<string, unknown>) => void = (m, d) => console.info(m, d)
): Promise<RuntimeStopResult> {
  const normalizedUserId = targetUserId.endsWith('-host') ? targetUserId.slice(0, -5) : targetUserId;
  const stoppedModes: RuntimeStopMode[] = [];

  if (mode !== 'container') {
    const hostHandle = maps.hostRuntimeHandles.get(normalizedUserId) || maps.hostRuntimeHandles.get(targetUserId);
    if (hostHandle) {
      log('[host-runtime] stopping runtime', {
        userId: normalizedUserId,
        pid: (hostHandle.rawHandle as { pid?: number } | undefined)?.pid ?? null,
      });
      try {
        await hostHandle.stop();
        await hostHandle.teardown(false);
        stoppedModes.push('host');
      } catch {}
      maps.hostRuntimeHandles.delete(normalizedUserId);
      maps.hostRuntimeHandles.delete(targetUserId);
    }
  }

  if (mode !== 'host') {
    const handle = maps.runtimeHandles.get(normalizedUserId) || maps.runtimeHandles.get(targetUserId);
    if (handle) {
      try {
        await handle.stop();
        // Stop container but retain the volume!
        await handle.teardown(false);
        stoppedModes.push('container');
      } catch {}
      maps.runtimeHandles.delete(normalizedUserId);
      maps.runtimeHandles.delete(targetUserId);
    }
  }

  return { stopped: stoppedModes.length > 0, stoppedModes, normalizedUserId };
}
