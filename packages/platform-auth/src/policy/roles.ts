import type { User, ExecutionMode } from '@enkeep/platform-core';

export const PERMISSION_MANAGE_HOST_RUNTIME = 'manage_host_runtime';

export function canManageHostRuntime(user: User): boolean {
  return user.role === 'admin' && user.status === 'active';
}

export function canExecuteOnHost(user: User): boolean {
  return canManageHostRuntime(user);
}

export function hasPermission(user: User, permission: string): boolean {
  if (permission === PERMISSION_MANAGE_HOST_RUNTIME || permission === 'manage_host_runtime') {
    return canManageHostRuntime(user);
  }
  return false;
}

export function resolveExecutionMode(user: User, requestedMode?: ExecutionMode): ExecutionMode {
  if ((requestedMode as string) === 'host') {
    return canManageHostRuntime(user) ? ('host' as ExecutionMode) : 'container';
  }
  return 'container';
}
