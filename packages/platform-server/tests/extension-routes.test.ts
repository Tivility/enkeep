/**
 * Extension Routes and Canonical Install Contract Integration Tests
 *
 * Tests the authoritative unified `/api/manage/extensions/*` endpoints with a focus on:
 * 1. POST `/api/manage/extensions/install` (Git Source Contract):
 *    - Allowed top-level keys: sourceKind ('git'), spaceId, gitSource
 *    - gitSource keys: repositoryUrl (required), optional ref/subdirectory/credentialRef/expectedCommit/expectedChecksum
 *    - Strict rejection of legacy aliases (sourceType, scope, kind, plaintext secrets)
 *    - Idempotency-Key support
 * 2. POST `/api/manage/extensions/install` (Archive Source Contract):
 *    - Allowed top-level keys: sourceKind ('archive'), spaceId, archiveBase64, archiveFilename, expectedChecksum
 *    - Strict rejection of legacy aliases (sourceType, upload, nested archive object, archive alias, scope, kind)
 *    - Strict Base64 validation (canonical encoding, non-zero padding bits, length, valid characters)
 *    - Decoded buffer size limit (non-empty, <= MAX_SKILL_TOTAL_BYTES)
 *    - Archive filename safety validation (path traversal, separators, null bytes, extensions, reserved names)
 *    - Actual end-to-end archive install from Web contract mock
 * 3. Security Invariants (CSRF token, Origin validation, RBAC/Auth).
 *
 * @module @enkeep/platform-server/tests/extension-routes.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  PlatformServerMigrationRunner,
  ALL_PLATFORM_MIGRATIONS,
} from '../src/storage/migrations.js';
import { SqlitePlatformStorage } from '@enkeep/platform-storage-sqlite';
import { DefaultAuthService, provisionFixtures } from '@enkeep/platform-auth';
import { PlatformServer } from '../src/server/server.js';
import { TarWriter } from '@enkeep/backup-restore';
import type { RuntimeGateway } from '@enkeep/web-channel';
import {
  validateCanonicalBase64,
  validateArchiveFilename,
  validateChecksum,
  validateIdempotencyKey,
  assertStrictBodyShape,
} from '../src/extensions/extension-routes.js';
import { MAX_SKILL_TOTAL_BYTES } from '../src/skills/security-validator.js';

function createTarGzArchive(files: Array<{ path: string; content: string }>): Buffer {
  const writer = new TarWriter();
  for (const f of files) {
    writer.addFile({ path: f.path, data: Buffer.from(f.content, 'utf8') });
  }
  const tarBuffer = writer.finalize();
  return zlib.gzipSync(tarBuffer);
}

function createZipArchive(files: Array<{ path: string; content: string }>): Buffer {
  // Build a minimal uncompressed ZIP archive (compression method 0)
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const fileData = Buffer.from(file.content, 'utf8');
    const fileNameBuf = Buffer.from(file.path, 'utf8');
    const uncompressedSize = fileData.length;
    const compressedSize = fileData.length;

    // Local file header: 30 bytes + fileName.length + fileData.length
    const localHeader = Buffer.alloc(30 + fileNameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4); // Min version
    localHeader.writeUInt16LE(0, 6); // General flags
    localHeader.writeUInt16LE(0, 8); // Compression method: 0 (store)
    localHeader.writeUInt16LE(0, 10); // Time
    localHeader.writeUInt16LE(0, 12); // Date
    localHeader.writeUInt32LE(0, 14); // CRC-32 (0 for mock)
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(fileNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    fileNameBuf.copy(localHeader, 30);

    const fullLocalEntry = Buffer.concat([localHeader, fileData]);
    localHeaders.push(fullLocalEntry);

    // Central directory header: 46 bytes + fileName.length
    const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0, 8); // General flags
    centralHeader.writeUInt16LE(0, 10); // Compression method: 0
    centralHeader.writeUInt16LE(0, 12); // Time
    centralHeader.writeUInt16LE(0, 14); // Date
    centralHeader.writeUInt32LE(0, 16); // CRC-32
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(fileNameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(0, 38); // External file attributes
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    fileNameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += fullLocalEntry.length;
  }

  const centralDirBuffer = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;
  const centralDirSize = centralDirBuffer.length;

  // End of central directory record: 22 bytes
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8); // Number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10); // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, eocd]);
}

describe('Extension Routes & Canonical Install Contract', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let authService: DefaultAuthService;
  let server: PlatformServer;
  let baseUrl: string;
  let csrfToken: string;

  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let localGitRepoDir: string;

  let aliceUserId: string;
  let bobUserId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceSpaceId: string;

  const mockRuntimeGateway: RuntimeGateway = {
    async dispatchInbound() {
      return { accepted: true, turnId: 'turn_mock', dshSessionId: 'ses_mock' };
    },
    async getTurnStatus() {
      return { turnId: 'turn_mock', status: 'completed' as const };
    },
    async cancelTurn() {
      return true;
    },
  };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-ext-routes-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');
    localGitRepoDir = path.join(tempDir, 'test-git-extension');

    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(localGitRepoDir, { recursive: true });

    // Initialize local Git repository with valid SKILL.md
    execSync('git init -b main', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Extension Tester"', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git config user.email "ext-tester@enkeep.test"', { cwd: localGitRepoDir, stdio: 'ignore' });

    fs.writeFileSync(
      path.join(localGitRepoDir, 'SKILL.md'),
      `---
name: code-auditor
description: Production code auditor extension
---
# Code Auditor Extension
Audit instructions and rules.
`,
      'utf8'
    );
    execSync('git add SKILL.md', { cwd: localGitRepoDir, stdio: 'ignore' });
    execSync('git commit -m "feat: initial code-auditor extension commit"', { cwd: localGitRepoDir, stdio: 'ignore' });

    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    csrfToken = 'csrf_token_min_32_chars_for_extension_routes_test_123';

    storage = new SqlitePlatformStorage(db);
    authService = new DefaultAuthService(storage, {
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
    });

    server = new PlatformServer({
      database: db,
      storage,
      authService,
      host: '127.0.0.1',
      port: 0,
      cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      csrfToken,
      runtimeGateway: mockRuntimeGateway,
      dshHome,
      spacesDir,
      gitSourcePolicy: {
        allowedSchemes: ['file', 'https', 'ssh'],
        allowFileScheme: true,
        allowedFileRoots: [tempDir],
        allowedHosts: ['localhost'],
      },
    });

    const addr = await server.start();
    baseUrl = addr.url;

    // Provision test users
    const fixtures = await provisionFixtures(storage, authService, {
      adminUsername: 'alice',
      adminPassword: 'AlicePassword123!',
      userUsername: 'bob',
      userPassword: 'BobPassword123!',
      disabledUsername: 'charlie',
      disabledPassword: 'CharliePassword123!',
    });

    aliceUserId = fixtures.admin.id;
    bobUserId = fixtures.user.id;
    aliceSpaceId = fixtures.adminContainerSpace.id;

    fs.mkdirSync(path.join(spacesDir, fixtures.adminContainerSpace.folder), { recursive: true });

    // Log in Alice
    const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'alice', password: 'AlicePassword123!' }),
    });
    expect(aliceLogin.status).toBe(200);
    aliceCookie = aliceLogin.headers.get('set-cookie')!;

    // Log in Bob
    const bobLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enkeep-CSRF': csrfToken,
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword123!' }),
    });
    expect(bobLogin.status).toBe(200);
    bobCookie = bobLogin.headers.get('set-cookie')!;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Canonical POST /api/manage/extensions/install - Git Source Contract', () => {
    it('installs extension via Git with exact canonical schema (sourceKind, spaceId, gitSource)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        sourceKind: 'git',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
          ref: 'main',
          subdirectory: undefined,
        },
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data.slug).toBe('code-auditor');
      expect(json.data.sourceKind).toBe('git');
      expect(json.data.installedVersion).toBe(1);

      // Verify Idempotency replay with same Idempotency-Key returns success
      const replayRes = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      expect(replayRes.status).toBe(201);
      const replayJson = await replayRes.json();
      expect(replayJson.data.slug).toBe('code-auditor');
    });

    it('rejects legacy sourceType alias at top level with 400 Bad Request', async () => {
      const payload = {
        sourceType: 'git',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
        },
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/sourceKind/i);
    });

    it('rejects legacy scope and kind fields at top level with 400 Bad Request', async () => {
      const payloadWithScope = {
        sourceKind: 'git',
        scope: 'space',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
        },
      };

      const resScope = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payloadWithScope),
      });

      expect(resScope.status).toBe(400);
      const jsonScope = await resScope.json();
      expect(jsonScope.error.message).toMatch(/Unknown field "scope"/i);

      const payloadWithKind = {
        sourceKind: 'git',
        kind: 'skill',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
        },
      };

      const resKind = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payloadWithKind),
      });

      expect(resKind.status).toBe(400);
      const jsonKind = await resKind.json();
      expect(jsonKind.error.message).toMatch(/Unknown field "kind"/i);
    });

    it('rejects sourceKind upload alias with 400 Bad Request', async () => {
      const payload = {
        sourceKind: 'upload',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
        },
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/Unsupported sourceKind: "upload"/i);
    });

    it('rejects missing gitSource or missing repositoryUrl with 400 Bad Request', async () => {
      const resNoGitSource = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({ sourceKind: 'git', spaceId: aliceSpaceId }),
      });
      expect(resNoGitSource.status).toBe(400);

      const resNoRepoUrl = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceId,
          gitSource: { repositoryUrl: '' },
        }),
      });
      expect(resNoRepoUrl.status).toBe(400);
    });

    it('rejects plaintext secret fields in payload with 400 Bad Request', async () => {
      const payloadWithAuthToken = {
        sourceKind: 'git',
        spaceId: aliceSpaceId,
        gitSource: {
          repositoryUrl: `file://${localGitRepoDir}`,
          authToken: 'plaintext-secret-token',
        },
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payloadWithAuthToken),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/forbidden/i);
    });
  });

  describe('2. Canonical POST /api/manage/extensions/install - Archive Source Contract', () => {
    it('installs extension from Web contract mock archive payload (.tar.gz) successfully', async () => {
      const archiveBuf = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: `---
name: archive-security-skill
description: Archive installed security skill
---
# Security Skill
Instructions for security scanning.
`,
        },
      ]);
      const base64Str = archiveBuf.toString('base64');
      const idempotencyKey = crypto.randomUUID();

      // Flat payload conforming strictly to canonical contract
      const payload = {
        sourceKind: 'archive',
        spaceId: aliceSpaceId,
        archiveBase64: base64Str,
        archiveFilename: 'archive-security-skill.tar.gz',
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('archive-security-skill');
      expect(json.data.sourceKind).toBe('archive');
      expect(json.data.installedVersion).toBe(1);

      // Verify extension is retrievable via GET /api/manage/extensions/archive-security-skill
      const getRes = await fetch(`${baseUrl}/api/manage/extensions/archive-security-skill?spaceId=${aliceSpaceId}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      expect(getJson.data.slug).toBe('archive-security-skill');
    });

    it('installs extension from Web contract mock archive payload (.zip) successfully', async () => {
      const zipBuf = createZipArchive([
        {
          path: 'SKILL.md',
          content: `---
name: zip-extension-skill
description: Zip installed skill
---
# Zip Extension Skill
Instructions for zip extension.
`,
        },
      ]);
      const base64Str = zipBuf.toString('base64');

      const payload = {
        sourceKind: 'archive',
        spaceId: aliceSpaceId,
        archiveBase64: base64Str,
        archiveFilename: 'zip-extension-skill.zip',
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('zip-extension-skill');
    });

    it('rejects nested archive object alias with 400 Bad Request', async () => {
      const payload = {
        sourceKind: 'archive',
        spaceId: aliceSpaceId,
        archive: {
          archiveFilename: 'skill.tar.gz',
        },
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/Unknown field "archive"/i);
    });

    it('rejects legacy archive alias for archiveBase64 with 400 Bad Request', async () => {
      const payload = {
        sourceKind: 'archive',
        spaceId: aliceSpaceId,
        archive: 'aGVsbG8=',
        archiveFilename: 'skill.tar.gz',
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/Unknown field "archive"/i);
    });

    it('rejects legacy sourceType alias in archive request with 400 Bad Request', async () => {
      const payload = {
        sourceType: 'upload',
        spaceId: aliceSpaceId,
        archiveBase64: 'aGVsbG8=',
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/sourceKind/i);
    });

    it('rejects non-canonical Base64 encoding (e.g. non-zero padding bits) with 400 Bad Request', async () => {
      // 'ZE==' has non-zero padding bits in Base64 (canonical would be 'ZA==')
      const payload = {
        sourceKind: 'archive',
        spaceId: aliceSpaceId,
        archiveBase64: 'ZE==',
        archiveFilename: 'skill.tar.gz',
      };

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/canonically encoded base64/i);
    });

    it('rejects invalid Base64 characters and invalid padding with 400 Bad Request', async () => {
      // Invalid characters
      const resChars = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: 'not-valid-base64!@#$',
          archiveFilename: 'skill.tar.gz',
        }),
      });
      expect(resChars.status).toBe(400);

      // Unaligned length
      const resLength = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: 'abc', // 3 chars
          archiveFilename: 'skill.tar.gz',
        }),
      });
      expect(resLength.status).toBe(400);

      // Empty Base64
      const resEmpty = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: '',
          archiveFilename: 'skill.tar.gz',
        }),
      });
      expect(resEmpty.status).toBe(400);
    });

    it('rejects dangerous archiveFilename with path traversal or illegal characters with 400 Bad Request', async () => {
      const dummyBase64 = Buffer.from('dummy data').toString('base64');

      const dangerousFilenames = [
        '../../evil.tar.gz',
        'subdir/evil.tar.gz',
        'subdir\\evil.tar.gz',
        'evil\0.tar.gz',
        'evil.exe',
        'evil.sh',
        'CON.tar.gz',
        'PRN.zip',
        '.',
        '..',
        ' evil.tar.gz',
        'evil.tar.gz ',
      ];

      for (const fn of dangerousFilenames) {
        const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Enkeep-CSRF': csrfToken,
            Origin: baseUrl,
            Cookie: aliceCookie,
          },
          body: JSON.stringify({
            sourceKind: 'archive',
            spaceId: aliceSpaceId,
            archiveBase64: dummyBase64,
            archiveFilename: fn,
          }),
        });

        expect(res.status, `Expected 400 for filename: "${fn}"`).toBe(400);
      }
    });

    it('installs extension with matching expectedChecksum successfully', async () => {
      const archiveBuf = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: `---
name: checksum-valid-skill
description: Checksum matching test
---
# Checksum Valid Skill
`,
        },
      ]);
      const base64Str = archiveBuf.toString('base64');
      const expectedChecksum = crypto.createHash('sha256').update(archiveBuf).digest('hex');

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: base64Str,
          archiveFilename: 'checksum-valid-skill.tar.gz',
          expectedChecksum,
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.slug).toBe('checksum-valid-skill');
    });

    it('rejects archive payload when expectedChecksum mismatch occurs with 400 Bad Request', async () => {
      const archiveBuf = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: `---
name: checksum-test-skill
description: Checksum mismatch test
---
# Checksum Test Skill
`,
        },
      ]);
      const base64Str = archiveBuf.toString('base64');

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: base64Str,
          archiveFilename: 'checksum-test-skill.tar.gz',
          expectedChecksum: '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/checksum mismatch/i);
    });

    it('rejects invalid expectedChecksum format (not 64-hex SHA-256) with 400 Bad Request', async () => {
      const archiveBuf = createTarGzArchive([
        {
          path: 'SKILL.md',
          content: `---
name: checksum-bad-format-skill
description: Bad checksum format
---
# Bad Checksum Format
`,
        },
      ]);
      const base64Str = archiveBuf.toString('base64');

      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enkeep-CSRF': csrfToken,
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'archive',
          spaceId: aliceSpaceId,
          archiveBase64: base64Str,
          archiveFilename: 'checksum-bad-format-skill.tar.gz',
          expectedChecksum: 'invalid-non-hex-sha256',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.message).toMatch(/64-character/i);
    });

    it('enforces MAX_SKILL_TOTAL_BYTES decoded size limit in validateCanonicalBase64', () => {
      const hugeBuffer = Buffer.alloc(MAX_SKILL_TOTAL_BYTES + 1024, 0x41);
      const hugeBase64 = hugeBuffer.toString('base64');

      expect(() => {
        validateCanonicalBase64(hugeBase64, 'archiveBase64');
      }).toThrow(/exceeds maximum allowed limit/i);
    });
  });

  describe('3. Validator Unit Invariants & Strict Parsing', () => {
    it('validates canonical Base64 encoding strictly', () => {
      // Valid canonical Base64
      const validBuf = Buffer.from('Hello, Enkeep Unified Extensions!');
      const validBase64 = validBuf.toString('base64');
      const decoded = validateCanonicalBase64(validBase64, 'archiveBase64');
      expect(decoded.toString('utf8')).toBe('Hello, Enkeep Unified Extensions!');

      // Rejects non-canonical padding bits
      expect(() => validateCanonicalBase64('ZE==')).toThrow(/canonically encoded/i);

      // Rejects unaligned length
      expect(() => validateCanonicalBase64('abc')).toThrow(/multiple of 4/i);

      // Rejects invalid characters
      expect(() => validateCanonicalBase64('aGVsbG8===')).toThrow(/multiple of 4/i);
      expect(() => validateCanonicalBase64('aGVsbG8!@#$')).toThrow(/multiple of 4/i);
      expect(() => validateCanonicalBase64('aGVs!@#$')).toThrow(/strict base64/i);

      // Rejects empty / whitespace
      expect(() => validateCanonicalBase64('')).toThrow(/must not be empty/i);
      expect(() => validateCanonicalBase64('   ')).toThrow(/whitespace/i);
      expect(() => validateCanonicalBase64(null)).toThrow(/required/i);
      expect(() => validateCanonicalBase64(undefined)).toThrow(/required/i);
      expect(() => validateCanonicalBase64(12345)).toThrow(/must be a string/i);
    });

    it('validates archive filenames strictly', () => {
      expect(validateArchiveFilename('skill.tar.gz')).toBe('skill.tar.gz');
      expect(validateArchiveFilename('skill.tgz')).toBe('skill.tgz');
      expect(validateArchiveFilename('skill.tar')).toBe('skill.tar');
      expect(validateArchiveFilename('skill.zip')).toBe('skill.zip');
      expect(validateArchiveFilename(undefined)).toBeUndefined();
      expect(validateArchiveFilename(null)).toBeUndefined();

      expect(() => validateArchiveFilename('../../evil.tar.gz')).toThrow();
      expect(() => validateArchiveFilename('sub/evil.tar.gz')).toThrow();
      expect(() => validateArchiveFilename('sub\\evil.tar.gz')).toThrow();
      expect(() => validateArchiveFilename('evil\0.tar.gz')).toThrow();
      expect(() => validateArchiveFilename('evil.exe')).toThrow(/valid archive extension/i);
      expect(() => validateArchiveFilename('CON.tar.gz')).toThrow(/reserved system device/i);
      expect(() => validateArchiveFilename('.')).toThrow();
      expect(() => validateArchiveFilename('..')).toThrow();
      expect(() => validateArchiveFilename('a'.repeat(256) + '.tar.gz')).toThrow(/length/i);
      expect(() => validateArchiveFilename(123)).toThrow(/must be a string/i);
    });

    it('validates Idempotency-Key strictly', () => {
      const validUuid = crypto.randomUUID();
      expect(validateIdempotencyKey(validUuid)).toBe(validUuid.toLowerCase());
      expect(validateIdempotencyKey(undefined)).toBeUndefined();
      expect(validateIdempotencyKey(null)).toBeUndefined();

      expect(() => validateIdempotencyKey('not-a-uuid')).toThrow(/canonical UUID v4/i);
      expect(() => validateIdempotencyKey(['uuid1', 'uuid2'])).toThrow(/Duplicate Idempotency-Key/i);
      expect(() => validateIdempotencyKey('')).toThrow(/non-empty string/i);
    });

    it('validates Checksum strictly', () => {
      const validSha = crypto.createHash('sha256').update('test').digest('hex');
      expect(validateChecksum(validSha)).toBe(validSha.toLowerCase());
      expect(validateChecksum(undefined)).toBeUndefined();
      expect(validateChecksum(null)).toBeUndefined();

      expect(() => validateChecksum('12345')).toThrow(/64-character/i);
      expect(() => validateChecksum('z'.repeat(64))).toThrow(/64-character/i);
    });
  });

  describe('4. CSRF and Authentication Defenses on Extension Routes', () => {
    it('rejects state-modifying POST /api/manage/extensions/install without CSRF token (403)', async () => {
      const res = await fetch(`${baseUrl}/api/manage/extensions/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Cookie: aliceCookie,
        },
        body: JSON.stringify({
          sourceKind: 'git',
          spaceId: aliceSpaceId,
          gitSource: { repositoryUrl: `file://${localGitRepoDir}` },
        }),
      });

      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/manage/extensions`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });
  });
});
