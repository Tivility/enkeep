/**
 * Security Subsystem Unit Tests
 *
 * Tests:
 * - CredentialResolverPort in-memory resolution & secret redaction
 * - Environment variable whitelisting & dangerous env stripper
 * - Executable allowlist & command injection prevention
 * - Manifest contract validation & Admin approval policy
 * - SSRF guard & DNS IP resolution checks
 * - Sanitizer bounds, null byte stripping, and image/prompt/sampling validation
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryCredentialResolver,
  redactSecret,
  redactObject,
  isSensitiveKey,
} from '../src/security/credential-resolver.js';
import {
  filterChildEnvironment,
  isDangerousEnvVar,
} from '../src/security/env-filter.js';
import {
  validateExecutable,
  validateMcpContributionManifest,
} from '../src/security/executable-guard.js';
import {
  isPrivateIPv4,
  isPrivateIPv6,
  validateSsrfTargetUrl,
  sanitizeHttpHeaders,
} from '../src/security/ssrf-guard.js';
import {
  sanitizeString,
  sanitizeToolContent,
  sanitizeToolCallResult,
  normalizeInputSchema,
} from '../src/security/sanitizer.js';
import { McpErrorCode, McpServiceError } from '../src/errors.js';
import type { McpStdioContributionManifest, McpHttpContributionManifest } from '../src/types.js';

describe('Security Subsystem: Credential Resolver & Redaction', () => {
  it('resolves ephemeral credentials per user and credentialRef', async () => {
    const resolver = new InMemoryCredentialResolver();
    resolver.setCredentials('alice', 'github_auth', {
      env: { GITHUB_TOKEN: 'ghp_secret12345678' },
      headers: { Authorization: 'Bearer ghp_secret12345678' },
    });

    const aliceCreds = await resolver.resolveCredentials('alice', { id: 'github_auth' });
    expect(aliceCreds).toEqual({
      env: { GITHUB_TOKEN: 'ghp_secret12345678' },
      headers: { Authorization: 'Bearer ghp_secret12345678' },
    });

    // Bob cannot resolve Alice's credential
    const bobCreds = await resolver.resolveCredentials('bob', { id: 'github_auth' });
    expect(bobCreds).toBeNull();
  });

  it('redacts sensitive keys and secret tokens', () => {
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('user_token')).toBe(true);
    expect(isSensitiveKey('username')).toBe(false);

    expect(redactSecret('secret123456')).toBe('sec...456');
    expect(redactSecret('short')).toBe('********');

    const sample = {
      api_key: 'supersecrettoken123',
      name: 'test_tool',
      nested: {
        token: 'anothersecrettoken456',
        description: 'Contains supersecrettoken123 in text',
      },
    };

    const redacted = redactObject(sample, ['supersecrettoken123', 'anothersecrettoken456']);
    expect(redacted.api_key).toBe('sup...123');
    expect(redacted.nested.token).toBe('ano...456');
    expect(redacted.nested.description).toBe('Contains ******** in text');
  });
});

describe('Security Subsystem: Environment Filter', () => {
  it('detects dangerous environment variables', () => {
    expect(isDangerousEnvVar('LD_PRELOAD')).toBe(true);
    expect(isDangerousEnvVar('DYLD_INSERT_LIBRARIES')).toBe(true);
    expect(isDangerousEnvVar('NODE_OPTIONS')).toBe(true);
    expect(isDangerousEnvVar('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isDangerousEnvVar('DSH_INTERNAL_TOKEN')).toBe(true);
    expect(isDangerousEnvVar('PATH')).toBe(false);
    expect(isDangerousEnvVar('HOME')).toBe(false);
  });

  it('filters out non-whitelisted host environment variables', () => {
    const hostEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/alice',
      SECRET_HOST_PASSWORD: 'password123',
      DSH_TOKEN: 'dsh_secret',
    };

    const clean = filterChildEnvironment(hostEnv, { MY_VAR: 'hello' }, { SECRET_KEY: 'token' });
    expect(clean.PATH).toBe('/usr/bin:/bin');
    expect(clean.HOME).toBe('/Users/alice');
    expect(clean.MY_VAR).toBe('hello');
    expect(clean.SECRET_KEY).toBe('token');
    expect(clean.SECRET_HOST_PASSWORD).toBeUndefined();
    expect(clean.DSH_TOKEN).toBeUndefined();
  });

  it('rejects dangerous environment variables in server env or ephemeral env', () => {
    expect(() => {
      filterChildEnvironment({}, { NODE_OPTIONS: '--inspect' });
    }).toThrowError(/rejected by security policy/);

    expect(() => {
      filterChildEnvironment({}, {}, { LD_PRELOAD: '/lib/evil.so' });
    }).toThrowError(/rejected by security policy/);
  });
});

describe('Security Subsystem: Executable Guard & Manifest Contracts', () => {
  it('allows standard whitelisted binaries', () => {
    const { resolvedCommand } = validateExecutable('node', ['script.js']);
    expect(resolvedCommand).toBe('node');

    const pythonRes = validateExecutable('python3', ['app.py']);
    expect(pythonRes.resolvedCommand).toBe('python3');
  });

  it('rejects direct shell execution', () => {
    expect(() => validateExecutable('bash', ['-c', 'evil'])).toThrowError(/Direct shell invocation/);
    expect(() => validateExecutable('sh', ['-c', 'evil'])).toThrowError(/Direct shell invocation/);
    expect(() => validateExecutable('cmd.exe', ['/c', 'dir'])).toThrowError(/Direct shell invocation/);
  });

  it('rejects forbidden shell metacharacters in command name or arguments', () => {
    expect(() => validateExecutable('node; rm -rf /')).toThrowError(/shell metacharacters/);
    expect(() => validateExecutable('python3 | evil')).toThrowError(/shell metacharacters/);
    expect(() => validateExecutable('node && whoami')).toThrowError(/shell metacharacters/);
    expect(() => validateExecutable('node', ['arg1; rm -rf /'])).toThrowError(/shell metacharacters/);
    expect(() => validateExecutable('node', ['`whoami`'])).toThrowError(/shell metacharacters/);
  });

  it('validates paths within allowlisted package roots', () => {
    const valid = validateExecutable('/app/packages/mcp-server/index.js', [], {
      packageRoots: ['/app/packages'],
    });
    expect(valid.resolvedCommand).toBe('/app/packages/mcp-server/index.js');

    // Path traversal outside package root
    expect(() => {
      validateExecutable('/app/packages/../../etc/passwd', [], {
        packageRoots: ['/app/packages'],
      });
    }).toThrowError(/not contained in allowlisted package roots/);
  });

  it('validates stdio and http contribution manifests', () => {
    const stdioManifest: McpStdioContributionManifest = {
      id: 'ext_mcp_1',
      name: 'Ext MCP',
      transport: 'stdio',
      command: 'node',
      argv: ['server.js'],
      source: 'builtin',
    };
    const validStdio = validateMcpContributionManifest(stdioManifest);
    expect(validStdio.transport).toBe('stdio');
    expect(validStdio.id).toBe('ext_mcp_1');

    const httpManifest: McpHttpContributionManifest = {
      id: 'ext_http_1',
      name: 'HTTP MCP',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      source: 'builtin',
    };
    const validHttp = validateMcpContributionManifest(httpManifest);
    expect(validHttp.transport).toBe('streamable-http');
    expect(validHttp.id).toBe('ext_http_1');
  });

  it('requires Admin approval for unapproved user extensions', () => {
    const unapproved: McpStdioContributionManifest = {
      id: 'user_ext_stdio',
      name: 'Dangerous Stdio',
      transport: 'stdio',
      command: 'node',
      argv: ['index.js'],
      source: 'user-extension',
      adminApproved: false,
    };

    expect(() => validateMcpContributionManifest(unapproved, { requireAdminApproval: true })).toThrowError(
      /requires Admin approval/,
    );

    // If admin approved, validation succeeds
    const approved = { ...unapproved, adminApproved: true };
    const res = validateMcpContributionManifest(approved, { requireAdminApproval: true });
    expect(res.id).toBe('user_ext_stdio');
  });
});

describe('Security Subsystem: SSRF Guard', () => {
  it('identifies private IPv4 addresses correctly', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.0.1.5')).toBe(true);
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateIPv4('192.168.1.1')).toBe(true);
    expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
  });

  it('identifies private IPv6 addresses correctly', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects non-HTTPS public endpoints', async () => {
    await expect(validateSsrfTargetUrl('http://example.com/mcp')).rejects.toThrowError(
      /must use HTTPS/,
    );
  });

  it('rejects private IP target URLs', async () => {
    await expect(validateSsrfTargetUrl('https://127.0.0.1:8080/mcp')).rejects.toThrowError(
      /Direct private IPv4 address/,
    );
    await expect(validateSsrfTargetUrl('https://169.254.169.254/latest')).rejects.toThrowError(
      /Direct private IPv4 address/,
    );
    await expect(validateSsrfTargetUrl('https://localhost/mcp')).rejects.toThrowError(
      /Local hostname/,
    );
  });

  it('allows localhost only when testing bypass flag is enabled', async () => {
    const res = await validateSsrfTargetUrl('http://127.0.0.1:3000/mcp', {
      allowLocalHttpForTesting: true,
    });
    expect(res.resolvedUrl.hostname).toBe('127.0.0.1');
  });

  it('sanitizes outgoing HTTP headers', () => {
    const headers = sanitizeHttpHeaders(
      { 'X-Custom-Header': 'val', Host: 'evil.com', Connection: 'keep-alive' },
      { Authorization: 'Bearer secret123', 'X-Forwarded-For': '1.2.3.4' },
    );

    expect(headers.get('X-Custom-Header')).toBe('val');
    expect(headers.get('Authorization')).toBe('Bearer secret123');
    expect(headers.has('Host')).toBe(false);
    expect(headers.has('Connection')).toBe(false);
    expect(headers.has('X-Forwarded-For')).toBe(false);
  });
});

describe('Security Subsystem: Sanitizer & Bounds', () => {
  it('strips null bytes and control chars from string output', () => {
    expect(sanitizeString('Hello\0World\x07!')).toBe('HelloWorld!');
    expect(sanitizeString('Line1\nLine2\tTab')).toBe('Line1\nLine2\tTab');
  });

  it('truncates oversized text output blocks', () => {
    const huge = 'A'.repeat(2000);
    const content = sanitizeToolContent({ type: 'text', text: huge }, 100);
    expect(content.type).toBe('text');
    if (content.type === 'text') {
      expect(content.text.length).toBeLessThan(200);
      expect(content.text).toContain('[output truncated by host policy]');
    }
  });

  it('rejects sampling and prompt requests', () => {
    expect(() => sanitizeToolContent({ type: 'sampling', messages: [] })).toThrowError(
      /rejected by host security policy/,
    );
    expect(() => sanitizeToolContent({ type: 'prompt', prompt: 'test' })).toThrowError(
      /rejected by host security policy/,
    );
  });

  it('sanitizes complete tool call results and normalizes input schemas', () => {
    const res = sanitizeToolCallResult({
      content: [{ type: 'text', text: 'Clean output\0' }],
      structuredContent: { status: 'ok', data: 123 },
      isError: false,
    });
    expect(res.content[0]).toEqual({ type: 'text', text: 'Clean output' });
    expect(res.structuredContent).toEqual({ status: 'ok', data: 123 });

    const schema = normalizeInputSchema(null);
    expect(schema).toEqual({ type: 'object', properties: {} });
  });
});
