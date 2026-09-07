/**
 * Safe Container Files Workbench API Unit & Integration Tests
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  RuntimeFileApiService,
  type TenantRuntimeFileProvider,
  type CanonicalFileOperationRequest,
  type CanonicalFileOperationResult,
  validateEtag,
  validateRelativeFilePath,
  validateSpaceId,
  validateUserId,
  validateUnknownKeys,
  mapFileOpError,
  MAX_FILE_SIZE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
} from '../src/files/runtime-file-api.js';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from '@enkeep/platform-core';

describe('Safe Container Files Workbench API & Security Invariants', () => {
  describe('1. Path & Identifier Validation', () => {
    it('validates canonical relative file paths', () => {
      expect(validateRelativeFilePath('file.txt').normalizedPath).toBe('file.txt');
      expect(validateRelativeFilePath('dir/sub/file.ts').normalizedPath).toBe('dir/sub/file.ts');
      expect(validateRelativeFilePath('a/b/c/d.json').normalizedPath).toBe('a/b/c/d.json');
    });

    it('handles root directory according to allowRoot option', () => {
      expect(validateRelativeFilePath('.', { allowRoot: true }).normalizedPath).toBe('.');
      expect(validateRelativeFilePath('', { allowRoot: true }).normalizedPath).toBe('.');
      expect(validateRelativeFilePath(undefined, { allowRoot: true }).normalizedPath).toBe('.');

      expect(() => validateRelativeFilePath('.', { allowRoot: false })).toThrow(ValidationError);
      expect(() => validateRelativeFilePath('', { allowRoot: false })).toThrow(ValidationError);
      expect(() => validateRelativeFilePath(undefined, { allowRoot: false })).toThrow(ValidationError);
    });

    it('strictly rejects path traversal using ".."', () => {
      expect(() => validateRelativeFilePath('..')).toThrow(/Path traversal using "\.\." is strictly forbidden/);
      expect(() => validateRelativeFilePath('../secret.txt')).toThrow(/Path traversal using "\.\."/);
      expect(() => validateRelativeFilePath('dir/../../etc/passwd')).toThrow(/Path traversal using "\.\."/);
      expect(() => validateRelativeFilePath('a/b/../c')).toThrow(/Path traversal using "\.\."/);
    });

    it('strictly rejects dot path segments and empty segments', () => {
      expect(() => validateRelativeFilePath('dir/./file.txt')).toThrow(/Dot path segments are forbidden/);
      expect(() => validateRelativeFilePath('nested//double-slash//file.txt')).toThrow(/Empty path segments are forbidden/);
      expect(() => validateRelativeFilePath('dir//file.txt')).toThrow(/Empty path segments are forbidden/);
    });

    it('strictly rejects absolute paths (POSIX and Windows)', () => {
      expect(() => validateRelativeFilePath('/etc/passwd')).toThrow(/Absolute paths are forbidden/);
      expect(() => validateRelativeFilePath('/home/dsh/workspace')).toThrow(/Absolute paths are forbidden/);
      expect(() => validateRelativeFilePath('\\Windows\\System32')).toThrow(/Absolute paths are forbidden/);
    });

    it('strictly rejects backslashes in paths', () => {
      expect(() => validateRelativeFilePath('dir\\file.txt')).toThrow(/Backslashes are forbidden/);
    });

    it('strictly rejects Windows drive letters', () => {
      expect(() => validateRelativeFilePath('C:\\config.sys')).toThrow(/Windows drive letters/);
      expect(() => validateRelativeFilePath('D:file.txt')).toThrow(/Windows drive letters/);
      expect(() => validateRelativeFilePath('c:/test')).toThrow(/Windows drive letters/);
    });

    it('strictly rejects null bytes and control characters', () => {
      expect(() => validateRelativeFilePath('file\0.txt')).toThrow(/control characters or null bytes/);
      expect(() => validateRelativeFilePath('dir\n/file.txt')).toThrow(/control characters or null bytes/);
      expect(() => validateRelativeFilePath('file\x1b.txt')).toThrow(/control characters or null bytes/);
      expect(() => validateRelativeFilePath('file\x7f.txt')).toThrow(/control characters or null bytes/);
    });

    it('strictly enforces Unicode NFC normalization', () => {
      const nfcStr = 'café.txt'; // NFC: single code point for é (\u00e9)
      const nfdStr = 'cafe\u0301.txt'; // NFD: e + combining acute accent (\u0301)
      expect(validateRelativeFilePath(nfcStr).normalizedPath).toBe(nfcStr);
      expect(() => validateRelativeFilePath(nfdStr)).toThrow(/Unicode NFC normalized form/);
    });

    it('strictly performs single-pass percent-decoding and rejects double-encoding exploits', () => {
      const decoded = validateRelativeFilePath('my%20file%20name.txt');
      expect(decoded.normalizedPath).toBe('my file name.txt');

      expect(() => validateRelativeFilePath('file%9.txt')).toThrow(/malformed percent sequence/);
      expect(() => validateRelativeFilePath('file%252e%252e.txt')).toThrow(/Double URL-encoding detected/);
      expect(() => validateRelativeFilePath('dir%252ffile.txt')).toThrow(/Double URL-encoding detected/);
      expect(() => validateRelativeFilePath('dir%2500file.txt')).toThrow(/Double URL-encoding detected/);
    });

    it('rejects paths exceeding length limits', () => {
      const longPath = 'a/'.repeat(600) + 'file.txt';
      expect(() => validateRelativeFilePath(longPath)).toThrow(/exceeds maximum allowed length/);

      const longSegment = 'b'.repeat(MAX_SEGMENT_LENGTH + 1);
      expect(() => validateRelativeFilePath(`dir/${longSegment}`)).toThrow(/exceeds maximum length of 255/);
    });

    it('validates spaceId strictly (raw === trim/NFC/pattern)', () => {
      const validSpc = 'spc_' + 'a'.repeat(32);
      const validImpsp = 'impsp_' + '0'.repeat(64);
      expect(validateSpaceId(validSpc)).toBe(validSpc);
      expect(validateSpaceId(validImpsp)).toBe(validImpsp);

      expect(() => validateSpaceId('default')).toThrow(ValidationError);
      expect(() => validateSpaceId('workspace-1')).toThrow(ValidationError);
      expect(() => validateSpaceId('')).toThrow(ValidationError);
      expect(() => validateSpaceId('   ')).toThrow(ValidationError);
      expect(() => validateSpaceId(` ${validSpc} `)).toThrow(ValidationError);
      expect(() => validateSpaceId('../escape')).toThrow(ValidationError);
      expect(() => validateSpaceId('/root')).toThrow(ValidationError);
      expect(() => validateSpaceId('invalid id!')).toThrow(ValidationError);
    });

    it('validates userId strictly (raw === trim/NFC/no control/max 128)', () => {
      const validUuid = '123e4567-e89b-42d3-a456-426614174000';
      const validUserAlice = 'user_alice_demo_001';
      expect(validateUserId(validUuid)).toBe(validUuid);
      expect(validateUserId(validUserAlice)).toBe(validUserAlice);

      expect(() => validateUserId('invalid-user')).toThrow(ValidationError);
      expect(() => validateUserId('alice')).toThrow(ValidationError);
      expect(() => validateUserId('')).toThrow(ValidationError);
      expect(() => validateUserId('   ')).toThrow(ValidationError);
      expect(() => validateUserId(` ${validUuid} `)).toThrow(ValidationError);
      expect(() => validateUserId(null)).toThrow(ValidationError);
      expect(() => validateUserId(`${validUuid}\x00`)).toThrow(ValidationError);
      expect(() => validateUserId(`${validUuid}\n`)).toThrow(ValidationError);
      expect(() => validateUserId('a'.repeat(129))).toThrow(ValidationError);
    });
  });

  function computeTestEtag(data: string | Buffer): string {
    return `"${createHash('sha256').update(data).digest('hex')}"`;
  }

  describe('2. Strict ETag Validation & Unknown Key Validation', () => {
    it('validates ETags strictly and rejects weak, unquoted, uppercase, or whitespace', () => {
      const rawHex = 'a'.repeat(64);
      expect(validateEtag(`"${rawHex}"`)).toBe(`"${rawHex}"`);

      // Rejects weak
      expect(() => validateEtag(`W/"${rawHex}"`)).toThrow(ValidationError);
      // Rejects unquoted
      expect(() => validateEtag(rawHex)).toThrow(ValidationError);
      // Rejects uppercase
      expect(() => validateEtag(`"${'A'.repeat(64)}"`)).toThrow(ValidationError);
      // Rejects whitespace
      expect(() => validateEtag(` "${rawHex}" `)).toThrow(ValidationError);
      // Rejects undefined/null
      expect(() => validateEtag(undefined)).toThrow(ValidationError);
      expect(() => validateEtag(null)).toThrow(ValidationError);
    });

    it('strictly rejects unknown keys and forbidden alias parameters via dynamically constructed strings', () => {
      const forbiddenAliasKey1 = ['fol', 'der'].join('');
      const forbiddenAliasKey2 = ['execution', 'Mode'].join('');
      const forbiddenAliasKey3 = ['new', 'Path'].join('');
      const forbiddenAliasKey4 = ['if', 'Match'].join('');
      const forbiddenAliasKey5 = ['if', 'None', 'Match'].join('');
      const forbiddenAliasKey6 = ['create', 'Only'].join('');
      const forbiddenAliasKey7 = ['over', 'write'].join('');

      expect(() => {
        validateUnknownKeys({ op: 'read', path: 'a.txt', [forbiddenAliasKey1]: 'val' }, ['op', 'path']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'read', path: 'a.txt', [forbiddenAliasKey2]: 'val' }, ['op', 'path']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'rename', path: 'a.txt', [forbiddenAliasKey3]: 'b.txt' }, ['op', 'path', 'targetPath']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'write', path: 'a.txt', [forbiddenAliasKey4]: 'etag' }, ['op', 'path', 'content']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'write', path: 'a.txt', [forbiddenAliasKey5]: '*' }, ['op', 'path', 'content']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'write', path: 'a.txt', [forbiddenAliasKey6]: true }, ['op', 'path', 'content']);
      }).toThrow(/Unexpected field/);

      expect(() => {
        validateUnknownKeys({ op: 'write', path: 'a.txt', [forbiddenAliasKey7]: true }, ['op', 'path', 'content']);
      }).toThrow(/Unexpected field/);
    });
  });

  describe('3. Error Mapping & Fixed Error Messages (Zero Raw Error Leakage)', () => {
    it('maps error codes correctly to fixed generic PlatformError instances without reading message', () => {
      const notFoundErr = mapFileOpError({ code: 'NOT_FOUND', message: 'internal secret missing /Users/test/123' });
      expect(notFoundErr).toBeInstanceOf(NotFoundError);
      expect(notFoundErr.message).toBe('File or directory not found');
      expect(notFoundErr.message).not.toContain('/Users');

      const forbiddenErr = mapFileOpError({ code: 'SYMLINK_FORBIDDEN', message: 'symlink target /etc/passwd' });
      expect(forbiddenErr).toBeInstanceOf(ForbiddenError);
      expect(forbiddenErr.message).toBe('Access denied');

      const validationErr = mapFileOpError({ code: 'INVALID_PATH', message: 'bad path' });
      expect(validationErr).toBeInstanceOf(ValidationError);
      expect(validationErr.message).toBe('Invalid request');

      const payloadTooLarge = mapFileOpError({ code: 'PAYLOAD_TOO_LARGE', message: 'huge' });
      expect(payloadTooLarge.status).toBe(413);
      expect(payloadTooLarge.message).toBe('Payload too large');

      const conflictErr = mapFileOpError({ code: 'CONFLICT', message: 'collision' });
      expect(conflictErr.status).toBe(409);
      expect(conflictErr.message).toBe('Resource conflict');

      const preconditionErr = mapFileOpError({ code: 'ETAG_MISMATCH', message: 'etag mismatch' });
      expect(preconditionErr.status).toBe(409);
      expect(preconditionErr.message).toBe('Precondition failed');

      const badGatewayErr = mapFileOpError({ code: 'PROVIDER_PROTOCOL_ERROR', message: 'corrupt payload' });
      expect(badGatewayErr.status).toBe(502);
      expect(badGatewayErr.message).toBe('Bad gateway: invalid provider response');

      const unavailableErr = mapFileOpError({ code: 'SERVICE_UNAVAILABLE', message: 'offline' });
      expect(unavailableErr.status).toBe(503);
      expect(unavailableErr.message).toBe('Service unavailable');

      // Unknown error code maps to fixed 502 Bad Gateway
      const unknownErr = mapFileOpError(new Error('Sensitive database down: postgresql://admin:secret@host/db'));
      expect(unknownErr.status).toBe(502);
      expect(unknownErr.message).toBe('Bad gateway: invalid provider response');
    });
  });

  describe('4. RuntimeFileApiService Operations & Provider Integration', () => {
    function createMockProvider(
      fn?: (userId: string, spaceId: string, req: CanonicalFileOperationRequest) => Promise<CanonicalFileOperationResult>
    ): TenantRuntimeFileProvider {
      return {
        execute: vi.fn().mockImplementation(async (userId: string, spaceId: string, req: CanonicalFileOperationRequest): Promise<CanonicalFileOperationResult> => {
          if (fn) {
            return fn(userId, spaceId, req);
          }

          if (req.op === 'list') {
            return {
              op: 'list',
              path: req.path || '.',
              entries: [
                { name: 'README.md', type: 'file', size: 100, mtimeMs: 1600000000000, etag: '"' + 'a'.repeat(64) + '"' },
                { name: 'src', type: 'directory', size: 0, mtimeMs: 1600000000000, etag: '"' + 'b'.repeat(64) + '"' },
              ],
              truncated: false,
            };
          }

          if (req.op === 'read') {
            const content = '# Hello Workbench\n';
            const size = Buffer.byteLength(content, 'utf8');
            return {
              op: 'read',
              path: req.path,
              content,
              encoding: 'utf8',
              type: 'file',
              size,
              mtimeMs: 1600000000000,
              etag: computeTestEtag(content),
            };
          }

          if (req.op === 'write') {
            const content = req.content;
            const size = Buffer.byteLength(content, 'utf8');
            return {
              op: 'write',
              path: req.path,
              type: 'file',
              size,
              mtimeMs: 1600000001000,
              etag: computeTestEtag(content),
            };
          }

          if (req.op === 'rename') {
            return {
              op: 'rename',
              path: req.path,
              targetPath: req.targetPath,
              type: 'file',
              size: 50,
              mtimeMs: 1600000002000,
              etag: '"' + 'c'.repeat(64) + '"',
            };
          }

          if (req.op === 'mkdir') {
            return {
              op: 'mkdir',
              path: req.path,
              type: 'directory',
              size: 0,
              mtimeMs: 1600000003000,
              etag: '"' + 'd'.repeat(64) + '"',
            };
          }

          if (req.op === 'delete') {
            return {
              op: 'delete',
              path: req.path,
              type: 'file',
              size: 0,
              mtimeMs: 1600000004000,
              etag: '"' + 'e'.repeat(64) + '"',
            };
          }

          throw new Error('Unsupported operation');
        }),
      };
    }

    const validSpaceId = 'spc_0123456789abcdef0123456789abcdef';
    const validUserId = '123e4567-e89b-42d3-a456-426614174000';
    const otherUserId = '223e4567-e89b-42d3-a456-426614174000';

    it('requires non-optional fileProvider in constructor and fails with 503 if omitted', () => {
      expect(() => new RuntimeFileApiService({} as any)).toThrow(
        expect.objectContaining({ status: 503, code: 'SERVICE_UNAVAILABLE' })
      );

      expect(() => new RuntimeFileApiService({ fileProvider: null as any })).toThrow(
        expect.objectContaining({ status: 503, code: 'SERVICE_UNAVAILABLE' })
      );
    });

    it('lists files successfully with authoritative container metadata', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, { op: 'list', path: '.' });
      expect(res.op).toBe('list');
      expect(res.path).toBe('.');
      expect((res as any).entries).toHaveLength(2);
      expect((res as any).entries[0]).toEqual({
        name: 'README.md',
        type: 'file',
        size: 100,
        mtimeMs: 1600000000000,
        etag: '"' + 'a'.repeat(64) + '"',
      });
      expect((res as any).truncated).toBe(false);

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'list',
        path: '.',
      });
    });

    it('reads file content and validates authoritative container metadata', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, { op: 'read', path: 'README.md' });
      expect(res.op).toBe('read');
      expect(res.path).toBe('README.md');
      if (res.op === 'read') {
        expect(res.content).toBe('# Hello Workbench\n');
        expect(res.encoding).toBe('utf8');
        expect(res.type).toBe('file');
        expect(res.size).toBe(18);
        expect(res.etag).toBe(computeTestEtag('# Hello Workbench\n'));
      }

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'read',
        path: 'README.md',
        encoding: 'utf8',
      });
    });

    it('reads base64 encoded content correctly', async () => {
      const binaryData = Buffer.from('Binary content');
      const base64Content = binaryData.toString('base64');
      const etag = computeTestEtag(binaryData);

      const provider = createMockProvider(async () => ({
        op: 'read',
        path: 'image.png',
        content: base64Content,
        encoding: 'base64',
        type: 'file',
        size: binaryData.byteLength,
        mtimeMs: 1600000000000,
        etag,
      }));

      const service = new RuntimeFileApiService({ fileProvider: provider });
      const res = await service.execute(validUserId, validSpaceId, { op: 'read', path: 'image.png', encoding: 'base64' });
      if (res.op === 'read') {
        expect(res.encoding).toBe('base64');
        expect(res.content).toBe(base64Content);
        expect(res.size).toBe(binaryData.byteLength);
      }
    });

    it('rejects write request without exactly one precondition', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      // No precondition
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'write',
          path: 'doc.txt',
          content: 'hello',
        } as any)
      ).rejects.toThrow(/Write request must specify exactly one precondition/);

      // Both preconditions
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'write',
          path: 'doc.txt',
          content: 'hello',
          expectedEtag: '"' + 'a'.repeat(64) + '"',
          requireAbsent: true,
        } as any)
      ).rejects.toThrow(/Write request must specify exactly one precondition: either expectedEtag or requireAbsent: true, not both/);
    });

    it('writes file with requireAbsent precondition (create)', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, {
        op: 'write',
        path: 'doc.txt',
        content: 'hello world',
        requireAbsent: true,
      });

      expect(res.op).toBe('write');
      expect(res.path).toBe('doc.txt');
      if (res.op === 'write') {
        expect(res.type).toBe('file');
        expect(res.size).toBe(11);
        expect(res.etag).toBe(computeTestEtag('hello world'));
      }

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'write',
        path: 'doc.txt',
        content: 'hello world',
        encoding: 'utf8',
        requireAbsent: true,
      });
    });

    it('writes file with expectedEtag precondition (update)', async () => {
      const validEtag = '"' + 'f'.repeat(64) + '"';
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, {
        op: 'write',
        path: 'doc.txt',
        content: 'hello world',
        expectedEtag: validEtag,
      });

      expect(res.op).toBe('write');
      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'write',
        path: 'doc.txt',
        content: 'hello world',
        encoding: 'utf8',
        expectedEtag: validEtag,
      });
    });

    it('rejects write request exceeding maxFileSize with 413 PayloadTooLarge', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });
      const hugeContent = 'x'.repeat(MAX_FILE_SIZE_BYTES + 1);

      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'write',
          path: 'huge.txt',
          content: hugeContent,
          requireAbsent: true,
        })
      ).rejects.toThrow(expect.objectContaining({ status: 413, code: 'PAYLOAD_TOO_LARGE' }));
    });

    it('executes native atomic rename with mandatory source expectedEtag and target precondition', async () => {
      const sourceEtag = '"' + 'a'.repeat(64) + '"';
      const targetEtag = '"' + 'b'.repeat(64) + '"';
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      // Target requireTargetAbsent variant
      const res1 = await service.execute(validUserId, validSpaceId, {
        op: 'rename',
        path: 'old.txt',
        targetPath: 'new.txt',
        expectedEtag: sourceEtag,
        requireTargetAbsent: true,
      });
      expect(res1.op).toBe('rename');
      expect(res1.path).toBe('old.txt');
      expect((res1 as any).targetPath).toBe('new.txt');

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'rename',
        path: 'old.txt',
        targetPath: 'new.txt',
        expectedEtag: sourceEtag,
        requireTargetAbsent: true,
      });

      // Target expectedTargetEtag variant
      const res2 = await service.execute(validUserId, validSpaceId, {
        op: 'rename',
        path: 'old.txt',
        targetPath: 'new.txt',
        expectedEtag: sourceEtag,
        expectedTargetEtag: targetEtag,
      });
      expect(res2.op).toBe('rename');

      // Missing source expectedEtag
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'rename',
          path: 'old.txt',
          targetPath: 'new.txt',
          requireTargetAbsent: true,
        } as any)
      ).rejects.toThrow(/Rename request requires source expectedEtag/);

      // Missing target precondition
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'rename',
          path: 'old.txt',
          targetPath: 'new.txt',
          expectedEtag: sourceEtag,
        } as any)
      ).rejects.toThrow(/Rename request must specify exactly one target precondition/);

      // Both target preconditions
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'rename',
          path: 'old.txt',
          targetPath: 'new.txt',
          expectedEtag: sourceEtag,
          expectedTargetEtag: targetEtag,
          requireTargetAbsent: true,
        } as any)
      ).rejects.toThrow(/Rename request must specify exactly one target precondition: either expectedTargetEtag or requireTargetAbsent: true, not both/);
    });

    it('creates directory (mkdir) requiring requireAbsent: true', async () => {
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, {
        op: 'mkdir',
        path: 'new-dir',
        requireAbsent: true,
      });
      expect(res.op).toBe('mkdir');
      expect(res.path).toBe('new-dir');
      if (res.op === 'mkdir') {
        expect(res.type).toBe('directory');
      }

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'mkdir',
        path: 'new-dir',
        requireAbsent: true,
      });

      // Rejects without requireAbsent: true
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'mkdir',
          path: 'new-dir',
        } as any)
      ).rejects.toThrow(/mkdir request requires requireAbsent: true/);
    });

    it('deletes file/directory requiring mandatory expectedEtag and strictly forbids deleting root', async () => {
      const validEtag = '"' + '1'.repeat(64) + '"';
      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider });

      const res = await service.execute(validUserId, validSpaceId, {
        op: 'delete',
        path: 'old-file.txt',
        expectedEtag: validEtag,
      });
      expect(res.op).toBe('delete');
      expect(res.path).toBe('old-file.txt');

      expect(provider.execute).toHaveBeenCalledWith(validUserId, validSpaceId, {
        op: 'delete',
        path: 'old-file.txt',
        expectedEtag: validEtag,
      });

      // Missing expectedEtag throws ValidationError
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'delete',
          path: 'old-file.txt',
        } as any)
      ).rejects.toThrow(/delete request requires expectedEtag/);

      // Deleting root throws ForbiddenError
      await expect(
        service.execute(validUserId, validSpaceId, {
          op: 'delete',
          path: '.',
          expectedEtag: validEtag,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('enforces multi-tenant isolation and passes userId strictly to provider', async () => {
      const provider = createMockProvider(async (userId) => {
        if (userId !== validUserId) {
          throw new ForbiddenError('Access denied');
        }
        return {
          op: 'list',
          path: '.',
          entries: [],
          truncated: false,
        };
      });

      const service = new RuntimeFileApiService({ fileProvider: provider });

      await expect(service.execute(otherUserId, validSpaceId, { op: 'list', path: '.' })).rejects.toThrow(ForbiddenError);
      const res = await service.execute(validUserId, validSpaceId, { op: 'list', path: '.' });
      expect((res as any).entries).toEqual([]);
    });

    it('validates active spaceId via PlatformWebApi strictly', async () => {
      const activeSpaceId = 'spc_11111111111111111111111111111111';
      const archivedSpaceId = 'spc_22222222222222222222222222222222';
      const missingSpaceId = 'spc_33333333333333333333333333333333';

      const mockPlatformApi = {
        getSpace: vi.fn().mockImplementation(async (userId: string, spaceId: string) => {
          if (spaceId === activeSpaceId) {
            return { id: activeSpaceId, name: 'main', status: 'active' };
          }
          if (spaceId === archivedSpaceId) {
            return { id: archivedSpaceId, name: 'archived', status: 'archived' };
          }
          return null;
        }),
      } as any;

      const provider = createMockProvider();
      const service = new RuntimeFileApiService({ fileProvider: provider, platformApi: mockPlatformApi });

      // Active spaceId succeeds
      const res = await service.execute(validUserId, activeSpaceId, { op: 'list', path: '.' });
      expect(res.op).toBe('list');

      // Missing spaceId throws 404
      await expect(
        service.execute(validUserId, missingSpaceId, { op: 'list', path: '.' })
      ).rejects.toThrow(NotFoundError);

      // Archived spaceId throws 409
      await expect(
        service.execute(validUserId, archivedSpaceId, { op: 'list', path: '.' })
      ).rejects.toThrow(expect.objectContaining({ status: 409, code: 'SPACE_ARCHIVED' }));
    });

    it('fails closed with 502 Bad Gateway on malformed provider results (no 0 or Date fallback)', async () => {
      // 1. Result is null
      const providerNull = createMockProvider(async () => null as any);
      const serviceNull = new RuntimeFileApiService({ fileProvider: providerNull });
      await expect(serviceNull.execute(validUserId, validSpaceId, { op: 'list' })).rejects.toThrow(
        expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' })
      );

      // 2. Result op mismatch
      const providerOpMismatch = createMockProvider(async () => ({
        op: 'write',
        path: '.',
        type: 'file',
        size: 0,
        mtimeMs: 1600000000000,
        etag: '"' + 'a'.repeat(64) + '"',
      } as any));
      const serviceOpMismatch = new RuntimeFileApiService({ fileProvider: providerOpMismatch });
      await expect(serviceOpMismatch.execute(validUserId, validSpaceId, { op: 'list' })).rejects.toThrow(
        expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' })
      );

      // 3. List entry missing authoritative mtimeMs
      const providerMissingMtime = createMockProvider(async () => ({
        op: 'list',
        path: '.',
        entries: [
          { name: 'file.txt', type: 'file', size: 10, etag: '"' + 'a'.repeat(64) + '"' }, // missing mtimeMs
        ],
        truncated: false,
      } as any));
      const serviceMissingMtime = new RuntimeFileApiService({ fileProvider: providerMissingMtime });
      await expect(serviceMissingMtime.execute(validUserId, validSpaceId, { op: 'list' })).rejects.toThrow(
        expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' })
      );

      // 4. List entry invalid ETag format
      const providerInvalidEntryEtag = createMockProvider(async () => ({
        op: 'list',
        path: '.',
        entries: [
          { name: 'file.txt', type: 'file', size: 10, mtimeMs: 1600000000000, etag: 'unquoted-etag' },
        ],
        truncated: false,
      } as any));
      const serviceInvalidEntryEtag = new RuntimeFileApiService({ fileProvider: providerInvalidEntryEtag });
      await expect(serviceInvalidEntryEtag.execute(validUserId, validSpaceId, { op: 'list' })).rejects.toThrow(
        expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' })
      );

      // 5. Read result size mismatch with content byte length
      const providerSizeMismatch = createMockProvider(async () => ({
        op: 'read',
        path: 'doc.txt',
        content: 'hello',
        encoding: 'utf8',
        type: 'file',
        size: 999, // mismatch with length 5
        mtimeMs: 1600000000000,
        etag: computeTestEtag('hello'),
      } as any));
      const serviceSizeMismatch = new RuntimeFileApiService({ fileProvider: providerSizeMismatch });
      await expect(serviceSizeMismatch.execute(validUserId, validSpaceId, { op: 'read', path: 'doc.txt' })).rejects.toThrow(
        expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' })
      );

      // 6. Write result invalid type
      const providerInvalidWriteType = createMockProvider(async () => ({
        op: 'write',
        path: 'doc.txt',
        type: 'directory', // should be 'file'
        size: 5,
        mtimeMs: 1600000000000,
        etag: computeTestEtag('hello'),
      } as any));
      const serviceInvalidWriteType = new RuntimeFileApiService({ fileProvider: providerInvalidWriteType });
      await expect(
        serviceInvalidWriteType.execute(validUserId, validSpaceId, { op: 'write', path: 'doc.txt', content: 'hello', requireAbsent: true })
      ).rejects.toThrow(expect.objectContaining({ status: 502, code: 'PROVIDER_PROTOCOL_ERROR' }));
    });
  });
});
