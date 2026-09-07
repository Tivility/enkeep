/**
 * In-Memory Ephemeral Credential Resolver and Secret Redaction
 *
 * Invariant: Ephemeral credentials are held in memory only, injected strictly
 * just-in-time into downstream stdio/HTTP calls, and redacted from all logs,
 * errors, and public responses.
 *
 * @module @enkeep/platform-service-mcp/security/credential-resolver
 */

import type {
  CredentialResolverPort,
  McpCredentialRef,
  McpResolvedCredentials,
} from '../types.js';

export class InMemoryCredentialResolver implements CredentialResolverPort {
  private readonly store = new Map<string, McpResolvedCredentials>();

  private key(userId: string, credentialRefId: string): string {
    return `${userId}:${credentialRefId}`;
  }

  setCredentials(
    userId: string,
    credentialRefId: string,
    credentials: McpResolvedCredentials,
  ): void {
    this.store.set(this.key(userId, credentialRefId), {
      env: credentials.env ? { ...credentials.env } : undefined,
      headers: credentials.headers ? { ...credentials.headers } : undefined,
    });
  }

  deleteCredentials(userId: string, credentialRefId: string): void {
    this.store.delete(this.key(userId, credentialRefId));
  }

  clear(): void {
    this.store.clear();
  }

  async resolveCredentials(
    userId: string,
    credentialRef: McpCredentialRef,
  ): Promise<McpResolvedCredentials | null> {
    const creds = this.store.get(this.key(userId, credentialRef.id));
    if (!creds) return null;
    return {
      env: creds.env ? { ...creds.env } : undefined,
      headers: creds.headers ? { ...creds.headers } : undefined,
    };
  }
}

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|auth(?:orization)?|token|secret|password|bearer|cookie|credential|private[-_]?key)/i;

/**
 * Checks if a key name suggests sensitive content.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim());
}

/**
 * Redacts secret string values.
 */
export function redactSecret(value: string | undefined): string {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

/**
 * Recursively redacts sensitive keys and known secret tokens in an arbitrary object.
 */
export function redactObject<T>(obj: T, knownSecrets: readonly string[] = []): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    let result: string = obj;
    for (const secret of knownSecrets) {
      if (secret && secret.length >= 4 && result.includes(secret)) {
        result = result.replaceAll(secret, '********');
      }
    }
    return result as any;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, knownSecrets)) as any;
  }
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveKey(k) && typeof v === 'string') {
        out[k] = redactSecret(v);
      } else {
        out[k] = redactObject(v, knownSecrets);
      }
    }
    return out as any;
  }
  return obj;
}
