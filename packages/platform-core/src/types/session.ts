export interface UserSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface CreateUserSessionInput {
  id?: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface UpdateUserSessionInput {
  lastSeenAt?: string;
  revokedAt?: string | null;
}
