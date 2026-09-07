export type AuthAuditAction =
  | 'login_success'
  | 'login_failure'
  | 'account_disabled'
  | 'session_revoked'
  | 'password_changed'
  | 'downgrade_trigger'
  | 'user_created'
  | 'user_updated'
  | 'profile_version_rolled_back'
  | 'locale_changed'
  | 'theme_changed'
  | 'space_mount.created'
  | 'space_mount.deleted'
  | 'host_runtime_space_created'
  | 'host_runtime_started'
  | 'host_runtime_stopped'
  | 'host_runtime_restarted'
  | 'extension.installed'
  | 'extension.updated'
  | 'extension.rollback'
  | 'extension.enabled'
  | 'extension.disabled'
  | 'extension.bound'
  | 'extension.unbound'
  | 'extension.uninstalled'
  | 'browser.open'
  | 'browser.snapshot'
  | 'browser.interact'
  | 'browser.screenshot'
  | 'browser.close'
  | 'mcp.call'
  | 'mcp.cancel';

export interface AuthAuditLog {
  id: string;
  userId?: string | null;
  username?: string | null;
  action: AuthAuditAction;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateAuthAuditLogInput {
  id?: string;
  userId?: string | null;
  username?: string | null;
  action: AuthAuditAction;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}
