import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import { PathPolicyViolationError } from '../src/errors/index.js';
import type { OutboundFileChannelAdapter } from '../src/types/file.js';

describe('File Operations Metadata & Path Policy Enforcement', () => {
  let storage: FakePlatformOperationsStorage;
  let mockFileAdapter: OutboundFileChannelAdapter;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    mockFileAdapter = {
      deliverFile: vi.fn().mockResolvedValue({ channelFileId: 'ext_file_123' }),
    };
    service = new PlatformOperationsService({
      storage,
      fileChannelAdapter: mockFileAdapter,
      filePathConfig: {
        maxSizeBytes: 5 * 1024 * 1024, // 5MB limit
      },
    });
  });

  it('successfully creates metadata and dispatches valid relative file path', async () => {
    const ops = service.forTenant('user_1');

    const result = await ops.files.sendFile({
      recipient: 'user_bob',
      path: 'docs/architecture/overview.pdf',
      size: 1024 * 50, // 50 KB
      description: 'System overview diagram',
    });

    expect(result.success).toBe(true);
    expect(result.fileId).toBeDefined();
    expect(result.metadata.filename).toBe('overview.pdf');
    expect(result.metadata.relativePath).toBe('docs/architecture/overview.pdf');
    expect(result.metadata.extension).toBe('.pdf');
    expect(result.metadata.mimeType).toBe('application/pdf');
    expect(result.metadata.size).toBe(51200);

    expect(mockFileAdapter.deliverFile).toHaveBeenCalledTimes(1);

    // Verify stored metadata
    const stored = await ops.files.getFile(result.fileId);
    expect(stored).not.toBeNull();
    expect(stored?.filename).toBe('overview.pdf');
  });

  it('rejects path traversal attempts (../ breakout)', async () => {
    const ops = service.forTenant('user_1');

    const maliciousPaths = [
      '../secret.env',
      '../../etc/passwd',
      'docs/../../root/secret.key',
      'subfolder/..',
    ];

    for (const p of maliciousPaths) {
      await expect(
        ops.files.sendFile({
          recipient: 'user_bob',
          path: p,
        })
      ).rejects.toThrow(PathPolicyViolationError);
    }
  });

  it('rejects absolute paths when allowAbsolute is false', async () => {
    const ops = service.forTenant('user_1');

    await expect(
      ops.files.sendFile({
        recipient: 'user_bob',
        path: '/etc/shadow',
      })
    ).rejects.toThrow(PathPolicyViolationError);
  });

  it('rejects null-byte injection', async () => {
    const ops = service.forTenant('user_1');

    await expect(
      ops.files.sendFile({
        recipient: 'user_bob',
        path: 'safe.txt\0.exe',
      })
    ).rejects.toThrow(PathPolicyViolationError);
  });

  it('rejects blocked executable extensions', async () => {
    const ops = service.forTenant('user_1');

    const dangerousFiles = [
      'scripts/deploy.sh',
      'tools/installer.exe',
      'binaries/malware.dll',
      'batch/run.bat',
      'scripts/payload.ps1',
    ];

    for (const p of dangerousFiles) {
      await expect(
        ops.files.sendFile({
          recipient: 'user_bob',
          path: p,
        })
      ).rejects.toThrow(PathPolicyViolationError);
    }
  });

  it('rejects files exceeding maximum size limit', async () => {
    const ops = service.forTenant('user_1');

    // 10MB file exceeds 5MB limit
    await expect(
      ops.files.sendFile({
        recipient: 'user_bob',
        path: 'large_data.json',
        size: 10 * 1024 * 1024,
      })
    ).rejects.toThrow(PathPolicyViolationError);
  });

  it('enforces custom extension allowlists if configured', async () => {
    const strictOps = service.forTenant('user_strict');

    // Send .json -> OK
    const jsonRes = await strictOps.files.sendFile(
      { recipient: 'user_bob', path: 'data.json' },
      { allowedExtensions: ['.json', '.csv'] }
    );
    expect(jsonRes.success).toBe(true);

    // Send .pdf -> Rejected because not in whitelist
    await expect(
      strictOps.files.sendFile(
        { recipient: 'user_bob', path: 'report.pdf' },
        { allowedExtensions: ['.json', '.csv'] }
      )
    ).rejects.toThrow(PathPolicyViolationError);
  });
});
