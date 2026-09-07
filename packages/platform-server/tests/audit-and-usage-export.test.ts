import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import {
  PlatformServer,
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
  sanitizeCsvCell,
  formatCsvRow,
} from '../src/index.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import type { RuntimeGateway } from '@enkeep/platform-core';

describe('Streaming Audit & Usage CSV/JSONL Export APIs', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;
  let adminId: string;
  let aliceId: string;
  let adminCookie: string;
  let aliceCookie: string;
  const cookieSecret = 'test_cookie_secret_0123456789abcdef0123456789abcdef';

  const fakeGateway: RuntimeGateway = {
    async executeTurn() {
      return {
        message: {
          id: 'msg_test',
          seq: 1,
          role: 'assistant',
          content: 'test',
          status: 'delivered',
          createdAt: new Date().toISOString(),
        },
      };
    },
  };

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret,
      sessionTtlSeconds: 3600,
      cookieSecure: false,
    });

    const fixtures = await provisionFixtures(storage, authService, {
      adminPassword: 'AdminPassword123!',
      userPassword: 'UserPassword123!',
      disabledPassword: 'DisabledPassword123!',
    });
    adminId = fixtures.admin.id;
    aliceId = fixtures.user.id;

    const adminLogin = await authService.login('alice', 'AdminPassword123!');
    adminCookie = adminLogin.cookieHeader.split(';')[0]!;

    const aliceLogin = await authService.login('bob', 'UserPassword123!');
    aliceCookie = aliceLogin.cookieHeader.split(';')[0]!;

    csrfToken = 'csrf_token_0123456789abcdef0123456789abcdef';
    server = new PlatformServer({
      database: db,
      storage,
      authService,
      cookieSecret,
      csrfToken,
      runtimeGateway: fakeGateway,
      host: '127.0.0.1',
      port: 0,
    });

    const info = await server.start();
    baseUrl = info.url;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  describe('1. CSV Injection Neutralization & Cell Formatting', () => {
    it('neutralizes dangerous formula prefixes (=, +, -, @, \\t, \\r) by prepending a single quote', () => {
      expect(sanitizeCsvCell('=1+1')).toBe("'=1+1");
      expect(sanitizeCsvCell('+cmd|/C')).toBe("'+cmd|/C");
      expect(sanitizeCsvCell('-2+3')).toBe("'-2+3");
      expect(sanitizeCsvCell('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
      expect(sanitizeCsvCell('\tmalicious_tab')).toBe("'\tmalicious_tab");
      expect(sanitizeCsvCell('\rmalicious_cr')).toBe("\"'\rmalicious_cr\"");
      expect(sanitizeCsvCell('Normal text')).toBe('Normal text');
      expect(sanitizeCsvCell(null)).toBe('');
      expect(sanitizeCsvCell(undefined)).toBe('');
    });

    it('escapes quotes and wraps values with commas or newlines in RFC 4180 quotes', () => {
      expect(sanitizeCsvCell('Hello, World')).toBe('"Hello, World"');
      expect(sanitizeCsvCell('Line 1\nLine 2')).toBe('"Line 1\nLine 2"');
      expect(sanitizeCsvCell('Value with "quotes"')).toBe('"Value with ""quotes"""');
      expect(formatCsvRow(['Col1', '=1+1', 'With, comma'])).toBe('Col1,\'=1+1,"With, comma"\r\n');
    });
  });

  describe('2. Audit Export API (GET /api/admin/audit/export)', () => {
    beforeEach(() => {
      // Seed diverse audit log records including malicious formula attempts and metadata
      db.prepare(`
        INSERT INTO auth_audit_log (id, user_id, username, action, ip_address, user_agent, details, created_at)
        VALUES
          ('aud_1', ?, 'alice', 'login_success', '127.0.0.1', 'Mozilla/5.0', '{"loginMode":"password"}', '2026-08-01T10:00:00.000Z'),
          ('aud_2', ?, 'alice', 'password_changed', '127.0.0.1', 'curl/7.68', '{"reason":"periodic"}', '2026-08-02T10:00:00.000Z'),
          ('aud_3', ?, '=cmd|/c calc', 'login_failure', '192.168.1.100', '+cmd|/C evil', '{"payload":"+cmd|/C evil"}', '2026-08-03T10:00:00.000Z'),
          ('aud_4', ?, 'bob', 'user_created', '127.0.0.1', 'Mozilla/5.0', '{"role":"user"}', '2026-08-04T10:00:00.000Z');
      `).run(adminId, adminId, aliceId, aliceId);
    });

    it('rejects unauthenticated requests (401) and non-admin requests (403)', async () => {
      const unauth = await fetch(`${baseUrl}/api/admin/audit/export`);
      expect(unauth.status).toBe(401);

      const forbidden = await fetch(`${baseUrl}/api/admin/audit/export`, {
        headers: { Cookie: aliceCookie },
      });
      expect(forbidden.status).toBe(403);
    });

    it('streams CSV audit export with UTF-8 BOM, headers, and neutralized cells', async () => {
      const res = await fetch(`${baseUrl}/api/admin/audit/export?format=csv`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/csv');
      expect(res.headers.get('Content-Disposition')).toContain('attachment; filename="audit-export-');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      // Check UTF-8 BOM bytes 0xEF, 0xBB, 0xBF
      expect(buf[0]).toBe(0xEF);
      expect(buf[1]).toBe(0xBB);
      expect(buf[2]).toBe(0xBF);

      const csvText = buf.toString('utf8');

      // Check CSV Header row
      expect(csvText).toContain('ID,User ID,Username,Action,IP Address,User Agent,Details,Created At');

      // Check data rows
      expect(csvText).toContain('aud_1');
      expect(csvText).toContain('login_success');

      // Check formula injection neutralization
      expect(csvText).toContain("'+cmd|/C evil");
      expect(csvText).toContain("'=cmd|/c calc");

      // Verify self-auditing: export created an 'audit_exported' entry in auth_audit_log
      const exportLogs = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'audit_exported'").all();
      expect(exportLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('streams JSONL audit export with structured objects and applies filters', async () => {
      const res = await fetch(`${baseUrl}/api/admin/audit/export?format=jsonl&action=password_changed`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');

      const jsonlText = await res.text();
      const lines = jsonlText.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);

      const item = JSON.parse(lines[0]);
      expect(item.id).toBe('aud_2');
      expect(item.action).toBe('password_changed');
      expect(item.details?.reason).toBe('periodic');
    });

    it('handles client abort cleanly during streaming without crashing or hanging', async () => {
      const url = new URL(`${baseUrl}/api/admin/audit/export?format=csv`);

      await new Promise<void>((resolve) => {
        const clientReq = http.request(
          url,
          {
            headers: { Cookie: adminCookie },
          },
          (clientRes) => {
            // Receive headers and immediately abort client stream
            clientRes.on('data', () => {
              clientReq.destroy();
              resolve();
            });
          }
        );
        clientReq.end();
      });

      // Small delay for server to finalize aborted stream
      await new Promise((r) => setTimeout(r, 50));

      // Verify server continues handling requests normally
      const checkRes = await fetch(`${baseUrl}/api/admin/audit?limit=1`, {
        headers: { Cookie: adminCookie },
      });
      const checkJson = await checkRes.json();
      if (checkRes.status !== 200) {
        console.error('CheckRes Error:', checkJson);
      }
      expect(checkRes.status).toBe(200);
    });
  });

  describe('3. Usage Export API (GET /api/admin/usage/export)', () => {
    it('rejects non-admin with 403', async () => {
      const forbidden = await fetch(`${baseUrl}/api/admin/usage/export`, {
        headers: { Cookie: aliceCookie },
      });
      expect(forbidden.status).toBe(403);
    });

    it('rejects unsupported date/model query parameters with 400 ValidationError', async () => {
      const res = await fetch(`${baseUrl}/api/admin/usage/export?from=2026-08-01`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('Date and model filters are not supported');
    });

    it('streams factual quota usage snapshot in CSV format with all 5 metrics for active users', async () => {
      const res = await fetch(`${baseUrl}/api/admin/usage/export?format=csv`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/csv');
      expect(res.headers.get('Content-Disposition')).toContain('attachment; filename="usage-snapshot-');

      const csvText = await res.text();
      expect(csvText).toContain('User ID,Username,As Of,Resource,Used Amount,Limit Amount,Remaining Amount,Reset Interval,Reset At');

      // Check factual quota metrics for users
      expect(csvText).toContain('tokens');
      expect(csvText).toContain('storage_bytes');
      expect(csvText).toContain('messages');
      expect(csvText).toContain('turns');
      expect(csvText).toContain('api_calls');

      // Verify no currency fabrication
      expect(csvText).not.toContain('$');
      expect(csvText).not.toContain('USD');

      // Verify self-auditing
      const exportLogs = db.prepare("SELECT * FROM auth_audit_log WHERE action = 'usage_exported'").all();
      expect(exportLogs.length).toBeGreaterThanOrEqual(1);
    });

    it('streams factual quota usage snapshot in JSONL format with line count >= users', async () => {
      const res = await fetch(`${baseUrl}/api/admin/usage/export?format=jsonl`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');

      const jsonlText = await res.text();
      const lines = jsonlText.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2); // At least alice and bob

      const item = JSON.parse(lines[0]);
      expect(item.userId).toBeDefined();
      expect(item.username).toBeDefined();
      expect(item.asOf).toBeDefined();
      expect(Array.isArray(item.quotas)).toBe(true);
      expect(item.quotas.length).toBe(5); // all 5 metrics present
    });
  });
});
