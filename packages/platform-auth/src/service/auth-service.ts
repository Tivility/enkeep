import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  User,
  AuthService,
  AuthServiceConfig,
  AuthContext,
  LoginResult,
  RotateSessionResult,
  SessionAuthResult,
  PlatformStorage,
} from '@enkeep/platform-core';
import { UnauthorizedError } from '@enkeep/platform-core';
import { hashPassword, verifyPassword } from '../password/scrypt.js';
import {
  hashToken,
  createSignedCookieValue,
  verifyAndDecodeCookieValue,
  buildSetCookieHeader,
  parseCookieFromHeader,
} from '../session/cookie.js';

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_COOKIE_NAME = 'enkeep_session';

const HEX_LOWER_64_REGEX = /^[0-9a-f]{64}$/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/;
const MAX_USERNAME_LEN = 128;
const MAX_PASSWORD_BYTES = 1024;
const MAX_IP_LEN = 45;
const MAX_USER_AGENT_LEN = 512;

// Constant dummy scrypt hash with standard work factors to equalize unknown vs bad password timing
const DUMMY_SCRYPT_HASH =
  'scrypt$16384$8$1$0123456789abcdef0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DUMMY_PASSWORD = 'dummy_timing_equalization_password';

function sanitizeContextIp(ip?: string | null): string | null {
  if (!ip || typeof ip !== 'string') return null;
  if (ip.length > MAX_IP_LEN || CONTROL_CHARS_REGEX.test(ip)) return null;
  return ip;
}

function sanitizeContextUserAgent(ua?: string | null): string | null {
  if (!ua || typeof ua !== 'string') return null;
  if (ua.length > MAX_USER_AGENT_LEN || CONTROL_CHARS_REGEX.test(ua)) return null;
  return ua;
}

function isValidUsername(username: unknown): username is string {
  if (typeof username !== 'string' || username.length === 0 || username.length > MAX_USERNAME_LEN) {
    return false;
  }
  if (CONTROL_CHARS_REGEX.test(username)) {
    return false;
  }
  return true;
}

function isValidPassword(password: unknown): password is string {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  const byteLen = Buffer.byteLength(password, 'utf8');
  if (byteLen < 1 || byteLen > MAX_PASSWORD_BYTES) {
    return false;
  }
  return true;
}

export class DefaultAuthService implements AuthService {
  private readonly storage: PlatformStorage;
  private readonly config: Required<AuthServiceConfig>;

  constructor(storage: PlatformStorage, config: AuthServiceConfig) {
    if (!config.cookieSecret || config.cookieSecret.length < 16) {
      throw new Error('AuthService requires a cookieSecret of at least 16 characters');
    }

    this.storage = storage;
    this.config = {
      cookieSecret: config.cookieSecret,
      sessionTtlSeconds: config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      cookieName: config.cookieName ?? DEFAULT_COOKIE_NAME,
      cookieSecure: config.cookieSecure ?? true,
      cookieSameSite: config.cookieSameSite ?? 'Strict',
      cookiePath: config.cookiePath ?? '/',
    };
  }

  async hashPassword(plaintext: string): Promise<string> {
    return hashPassword(plaintext);
  }

  async verifyPassword(plaintext: string, hash: string): Promise<boolean> {
    return verifyPassword(plaintext, hash);
  }

  async login(username: string, password: string, context?: AuthContext): Promise<LoginResult> {
    const ipAddress = sanitizeContextIp(context?.ipAddress);
    const userAgent = sanitizeContextUserAgent(context?.userAgent);

    // Strict input bounds and validation (exact NFC, no control chars, password byte bounds)
    const validUser = isValidUsername(username);
    const validPass = isValidPassword(password);

    if (!validUser || !validPass) {
      // Execute constant-time dummy scrypt verification to prevent input rejection timing attacks
      await this.verifyPassword(typeof password === 'string' && password ? password : DUMMY_PASSWORD, DUMMY_SCRYPT_HASH);

      // Audit must NEVER store attempted unknown/invalid username to prevent credential/PII leakage
      await this.storage.auditLogs.create({
        userId: null,
        username: null,
        action: 'login_failure',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_credentials' },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    // Lookup user by exact username (no trim or mutating normalization)
    const user = await this.storage.users.findByUsername(username);

    if (!user) {
      // Execute constant-time dummy scrypt verification to equalize timing with valid users
      await this.verifyPassword(password, DUMMY_SCRYPT_HASH);

      // Audit must NEVER store attempted unknown username (could be raw password/PII)
      await this.storage.auditLogs.create({
        userId: null,
        username: null,
        action: 'login_failure',
        ipAddress,
        userAgent,
        details: { reason: 'user_not_found' },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    const passwordValid = await this.verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      await this.storage.auditLogs.create({
        userId: user.id,
        username: user.username,
        action: 'login_failure',
        ipAddress,
        userAgent,
        details: { reason: 'invalid_password' },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    if (user.status === 'disabled') {
      await this.storage.auditLogs.create({
        userId: user.id,
        username: user.username,
        action: 'account_disabled',
        ipAddress,
        userAgent,
        details: { reason: 'account_disabled_at_login' },
      });
      // Unified 401 response without leaking username existence or account disabled status
      throw new UnauthorizedError('Invalid username or password');
    }

    // Generate token and session
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAtMs = Date.now() + this.config.sessionTtlSeconds * 1000;
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const session = await this.storage.sessions.create({
      userId: user.id,
      tokenHash,
      expiresAt: expiresAtIso,
      ipAddress,
      userAgent,
    });

    const signedCookieValue = createSignedCookieValue(
      session.id,
      token,
      expiresAtMs,
      this.config.cookieSecret
    );

    const cookieHeader = buildSetCookieHeader(this.config.cookieName, signedCookieValue, {
      path: this.config.cookiePath,
      maxAgeSeconds: this.config.sessionTtlSeconds,
      secure: this.config.cookieSecure,
      sameSite: this.config.cookieSameSite,
      httpOnly: true,
    });

    // Prohibit raw session ID in audit details; set details to null
    await this.storage.auditLogs.create({
      userId: user.id,
      username: user.username,
      action: 'login_success',
      ipAddress,
      userAgent,
      details: null,
    });

    return {
      user,
      session,
      sessionToken: token,
      cookieHeader,
    };
  }

  async authenticateCookie(cookieHeader: string, context?: AuthContext): Promise<SessionAuthResult> {
    const rawCookie = parseCookieFromHeader(cookieHeader, this.config.cookieName);
    if (!rawCookie) {
      return { authenticated: false, error: 'Invalid session' };
    }

    const payload = verifyAndDecodeCookieValue(rawCookie, this.config.cookieSecret);
    if (!payload) {
      return { authenticated: false, error: 'Invalid session' };
    }

    return this.authenticateToken(payload.sessionId, payload.token, context);
  }

  async authenticateToken(sessionId: string, token: string, context?: AuthContext): Promise<SessionAuthResult> {
    const ipAddress = sanitizeContextIp(context?.ipAddress);
    const userAgent = sanitizeContextUserAgent(context?.userAgent);

    if (!sessionId || !token || typeof sessionId !== 'string' || typeof token !== 'string') {
      return { authenticated: false, error: 'Invalid session' };
    }

    const session = await this.storage.sessions.findById(sessionId);
    if (!session) {
      return { authenticated: false, error: 'Invalid session' };
    }

    if (session.revokedAt) {
      return { authenticated: false, error: 'Invalid session' };
    }

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      return { authenticated: false, error: 'Invalid session' };
    }

    if (!session.tokenHash || typeof session.tokenHash !== 'string' || !HEX_LOWER_64_REGEX.test(session.tokenHash)) {
      return { authenticated: false, error: 'Invalid session' };
    }

    const expectedHash = hashToken(token);
    if (!HEX_LOWER_64_REGEX.test(expectedHash)) {
      return { authenticated: false, error: 'Invalid session' };
    }

    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const actualBuf = Buffer.from(session.tokenHash, 'hex');

    // Constant-time token hash verification using fixed 32-byte buffers
    if (
      expectedBuf.length !== 32 ||
      actualBuf.length !== 32 ||
      expectedBuf.toString('hex') !== expectedHash ||
      actualBuf.toString('hex') !== session.tokenHash ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return { authenticated: false, error: 'Invalid session' };
    }

    const user = await this.storage.users.findById(session.userId);
    if (!user) {
      return { authenticated: false, error: 'Invalid session' };
    }

    if (user.status === 'disabled') {
      await this.storage.auditLogs.create({
        userId: user.id,
        username: user.username,
        action: 'account_disabled',
        ipAddress,
        userAgent,
        details: { reason: 'account_disabled_during_session_auth' },
      });
      return { authenticated: false, error: 'Invalid session' };
    }

    // Touch last seen
    await this.storage.sessions.update(session.id, {
      lastSeenAt: new Date().toISOString(),
    });

    return {
      authenticated: true,
      user,
      session,
    };
  }

  async revokeSession(sessionId: string, revokedAt?: string): Promise<void> {
    await this.storage.sessions.revoke(sessionId, revokedAt);
  }

  async revokeAllUserSessions(userId: string, revokedAt?: string): Promise<number> {
    return this.storage.sessions.revokeAllForUser(userId, revokedAt);
  }

  async logout(sessionId: string, context?: AuthContext): Promise<void> {
    const ipAddress = sanitizeContextIp(context?.ipAddress);
    const userAgent = sanitizeContextUserAgent(context?.userAgent);

    const session = await this.storage.sessions.findById(sessionId);
    if (!session) {
      return;
    }

    await this.storage.sessions.revoke(sessionId);

    const user = await this.storage.users.findById(session.userId);
    await this.storage.auditLogs.create({
      userId: session.userId,
      username: user ? user.username : null,
      action: 'session_revoked',
      ipAddress,
      userAgent,
      details: null,
    });
  }

  async createSession(userId: string, context?: AuthContext): Promise<RotateSessionResult> {
    const ipAddress = sanitizeContextIp(context?.ipAddress);
    const userAgent = sanitizeContextUserAgent(context?.userAgent);

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAtMs = Date.now() + this.config.sessionTtlSeconds * 1000;
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const session = await this.storage.sessions.create({
      userId,
      tokenHash,
      expiresAt: expiresAtIso,
      ipAddress,
      userAgent,
    });

    const signedCookieValue = createSignedCookieValue(
      session.id,
      token,
      expiresAtMs,
      this.config.cookieSecret
    );

    const cookieHeader = buildSetCookieHeader(this.config.cookieName, signedCookieValue, {
      path: this.config.cookiePath,
      maxAgeSeconds: this.config.sessionTtlSeconds,
      secure: this.config.cookieSecure,
      sameSite: this.config.cookieSameSite,
      httpOnly: true,
    });

    return {
      session,
      sessionToken: token,
      cookieHeader,
    };
  }

  async rotateSession(userId: string, context?: AuthContext): Promise<RotateSessionResult> {
    // Revoke all existing active sessions for this user first
    await this.storage.sessions.revokeAllForUser(userId);

    // Create the fresh new session
    const newSessionResult = await this.createSession(userId, context);

    const user = await this.storage.users.findById(userId);
    await this.storage.auditLogs.create({
      userId,
      username: user ? user.username : null,
      action: 'session_revoked',
      ipAddress: sanitizeContextIp(context?.ipAddress),
      userAgent: sanitizeContextUserAgent(context?.userAgent),
      details: null,
    });

    return newSessionResult;
  }
}
