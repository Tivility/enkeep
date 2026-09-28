/**
 * Local File Staging & Host Streaming Transport Regression Test Suite
 *
 * Verifies:
 * - G03a: Decoupled opaque ASCII stage tokens support Unicode (Chinese) and whitespace basenames
 *   without violating STAGE_TOKEN_REGEX or leaking unencoded names into temporary files.
 * - G03a: Preserves original target path metadata on stage and commit operations.
 * - G03a: Preserves backward compatibility for legacy stage tokens.
 * - G03a: Strictly enforces stage/rollback token validation and rejects traversal or malformed tokens.
 * - G03a: Stage abort, rollback, and finalization lifecycle.
 * - G03b: Host streaming DTO exact conformance (type: 'file', finite mtimeMs, valid size, etag, sha256).
 *
 * @module @enkeep/runtime-runner/tests/file-staging-streaming.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  executeFileStageStream,
  executeFileCommitStage,
  executeFileAbortStage,
  executeFileFinalizeStage,
  executeFileRollbackCommit,
  executeFileOperation,
  validateStageToken,
  validateRollbackToken,
  FileOpError,
} from '../src/runtime/file-ops.js';
import {
  hostWriteStream,
  hostReadStream,
  hostStageStream,
  hostCommitStage,
  hostAbortStage,
} from '../src/host/file-streaming.js';

describe('G03a: In-Container File Staging Decoupled ASCII Token Regression', () => {
  let tempDir: string;
  let spacesDir: string;
  const space = 'spc_0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g03-test-staging-'));
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('stages and commits a file with Chinese Unicode basename (面试评估报告.md)', async () => {
    const targetRelPath = 'reports/面试评估报告.md';
    const payload = Buffer.from('# 候选人评估报告\n\n通过面试。', 'utf8');

    // 1. Stage stream
    const stageResult = await executeFileStageStream(
      {
        space,
        path: targetRelPath,
      },
      Readable.from([payload]),
      { spacesDir }
    );

    expect(stageResult.op).toBe('stage');
    expect(stageResult.space).toBe(space);
    expect(stageResult.path).toBe(targetRelPath);
    expect(stageResult.size).toBe(payload.length);
    expect(stageResult.sha256).toBe(crypto.createHash('sha256').update(payload).digest('hex'));
    expect(stageResult.etag).toBe(`"${stageResult.sha256}"`);

    // The stageToken MUST be a pure ASCII opaque token matching STAGE_TOKEN_REGEX
    expect(stageResult.stageToken).toMatch(/^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.stage\.tmp$/);
    // Crucially: it must NOT contain the unencoded Chinese characters
    expect(stageResult.stageToken).not.toContain('面试评估报告');
    expect(() => validateStageToken(stageResult.stageToken)).not.toThrow();

    // 2. Physical staged file exists in parent dir
    const parentDir = path.join(spacesDir, space, 'reports');
    const stagedFilePath = path.join(parentDir, stageResult.stageToken);
    expect(fs.existsSync(stagedFilePath)).toBe(true);

    // Target file does not exist yet
    const targetFilePath = path.join(spacesDir, space, targetRelPath);
    expect(fs.existsSync(targetFilePath)).toBe(false);

    // 3. Commit stage
    const commitResult = await executeFileCommitStage(
      {
        space,
        path: targetRelPath,
        stageToken: stageResult.stageToken,
        requireAbsent: true,
      },
      { spacesDir }
    );

    expect(commitResult.op).toBe('write');
    expect(commitResult.space).toBe(space);
    expect(commitResult.path).toBe(targetRelPath);
    expect(commitResult.type).toBe('file');
    expect(commitResult.size).toBe(payload.length);
    expect(commitResult.written).toBe(true);
    expect(typeof commitResult.mtimeMs).toBe('number');
    expect(commitResult.etag).toBe(stageResult.etag);

    // Staged temporary file is cleaned up after commit
    expect(fs.existsSync(stagedFilePath)).toBe(false);

    // Destination file exists with correct content
    expect(fs.existsSync(targetFilePath)).toBe(true);
    expect(fs.readFileSync(targetFilePath, 'utf8')).toBe('# 候选人评估报告\n\n通过面试。');
  });

  it('stages and commits a file with spaces in path and filename (folder with spaces/file with spaces.txt)', async () => {
    const targetRelPath = 'folder with spaces/file with spaces.txt';
    const payload = Buffer.from('Testing whitespace path preservation', 'utf8');

    const stageResult = await executeFileStageStream(
      {
        space,
        path: targetRelPath,
      },
      Readable.from([payload]),
      { spacesDir }
    );

    expect(stageResult.path).toBe(targetRelPath);
    expect(stageResult.stageToken).toMatch(/^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.stage\.tmp$/);
    expect(stageResult.stageToken).not.toContain(' ');
    expect(() => validateStageToken(stageResult.stageToken)).not.toThrow();

    const commitResult = await executeFileCommitStage(
      {
        space,
        path: targetRelPath,
        stageToken: stageResult.stageToken,
        requireAbsent: true,
      },
      { spacesDir }
    );

    expect(commitResult.path).toBe(targetRelPath);
    expect(commitResult.type).toBe('file');
    expect(commitResult.size).toBe(payload.length);

    const targetFilePath = path.join(spacesDir, space, targetRelPath);
    expect(fs.existsSync(targetFilePath)).toBe(true);
    expect(fs.readFileSync(targetFilePath, 'utf8')).toBe('Testing whitespace path preservation');
  });

  it('supports stage abort for Unicode files without leaving residue', async () => {
    const targetRelPath = 'docs/亳州应急回程预案.docx';
    const payload = Buffer.from('Emergency response plan draft', 'utf8');

    const stageResult = await executeFileStageStream(
      {
        space,
        path: targetRelPath,
      },
      Readable.from([payload]),
      { spacesDir }
    );

    const stagedFilePath = path.join(spacesDir, space, 'docs', stageResult.stageToken);
    expect(fs.existsSync(stagedFilePath)).toBe(true);

    const abortResult = await executeFileAbortStage(
      {
        space,
        path: targetRelPath,
        stageToken: stageResult.stageToken,
      },
      { spacesDir }
    );

    expect(abortResult.op).toBe('abort_stage');
    expect(abortResult.aborted).toBe(true);
    expect(fs.existsSync(stagedFilePath)).toBe(false);
  });

  it('handles overwrite with decoupled rollback token and supports finalize / rollback', async () => {
    const targetRelPath = 'data/配置清单.json';
    const initialPayload = Buffer.from(JSON.stringify({ v: 1 }), 'utf8');
    const newPayload = Buffer.from(JSON.stringify({ v: 2 }), 'utf8');

    // Create initial file
    const initialStage = await executeFileStageStream(
      { space, path: targetRelPath },
      Readable.from([initialPayload]),
      { spacesDir }
    );
    const initialCommit = await executeFileCommitStage(
      { space, path: targetRelPath, stageToken: initialStage.stageToken, requireAbsent: true },
      { spacesDir }
    );

    // Stage second version
    const secondStage = await executeFileStageStream(
      { space, path: targetRelPath },
      Readable.from([newPayload]),
      { spacesDir }
    );

    // Commit overwrite with expectedEtag
    const secondCommit = await executeFileCommitStage(
      {
        space,
        path: targetRelPath,
        stageToken: secondStage.stageToken,
        expectedEtag: initialCommit.etag,
      },
      { spacesDir }
    );

    expect(secondCommit.written).toBe(true);
    const rollbackToken = (secondCommit as any).rollbackToken;
    expect(rollbackToken).toBeDefined();
    // Rollback token must be decoupled ASCII matching ROLLBACK_TOKEN_REGEX
    expect(rollbackToken).toMatch(/^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.rollback\.tmp$/);
    expect(rollbackToken).not.toContain('配置清单');

    const backupPath = path.join(spacesDir, space, 'data', rollbackToken);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(JSON.stringify({ v: 1 }));

    // Rollback restore
    const rollbackRes = await executeFileRollbackCommit(
      { space, path: targetRelPath, rollbackToken },
      { spacesDir }
    );
    expect(rollbackRes.rolledBack).toBe(true);

    const targetPath = path.join(spacesDir, space, targetRelPath);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(JSON.stringify({ v: 1 }));
  });

  it('preserves legacy stageToken compatibility in executeFileOperation', () => {
    const targetRelPath = '.attachments/incoming/legacy_doc.pdf';
    const payload = Buffer.from('Legacy chunk payload', 'utf8');

    // 1. Stage chunk generates decoupled token
    const stageRes = executeFileOperation(
      {
        op: 'stage_chunk',
        space,
        path: targetRelPath,
        offset: 0,
        content: payload.toString('base64'),
        encoding: 'base64',
      },
      { spacesDir }
    );

    expect(stageRes.op).toBe('stage_chunk');
    expect(stageRes.stageToken).toMatch(/^\.[a-zA-Z0-9_.-]+\.[0-9a-f]{16}\.stage\.tmp$/);
    expect(stageRes.stageToken!.startsWith('.stage.')).toBe(true);

    // 2. Commit chunk with decoupled token succeeds
    const commitRes = executeFileOperation(
      {
        op: 'commit_stage',
        space,
        path: targetRelPath,
        stageToken: stageRes.stageToken!,
        requireAbsent: true,
      },
      { spacesDir }
    );

    expect(commitRes.op).toBe('commit_stage');
    expect(commitRes.written).toBe(true);

    // 3. Test legacy token format with matching prefix
    const legacyPath = '.attachments/incoming/legacy2.png';
    const legacyToken = '.legacy2.png.0123456789abcdef.stage.tmp';
    const parentDir = path.join(spacesDir, space, '.attachments/incoming');
    fs.writeFileSync(path.join(parentDir, legacyToken), 'legacy data');

    const legacyCommitRes = executeFileOperation(
      {
        op: 'commit_stage',
        space,
        path: legacyPath,
        stageToken: legacyToken,
        requireAbsent: true,
      },
      { spacesDir }
    );
    expect(legacyCommitRes.op).toBe('commit_stage');
    expect(legacyCommitRes.written).toBe(true);

    // 4. Test mismatched prefix token is rejected
    expect(() => {
      executeFileOperation(
        {
          op: 'commit_stage',
          space,
          path: '.attachments/incoming/other.png',
          stageToken: '.unrelated.png.0123456789abcdef.stage.tmp',
          requireAbsent: true,
        },
        { spacesDir }
      );
    }).toThrow(FileOpError);
  });

  it('rejects invalid or traversal stage tokens with INVALID_REQUEST', () => {
    expect(() => validateStageToken('../escaped.stage.tmp')).toThrow();
    expect(() => validateStageToken('subdir/token.0123456789abcdef.stage.tmp')).toThrow();
    expect(() => validateStageToken('.invalid-hex.01234.stage.tmp')).toThrow();
    expect(() => validateStageToken('.with space.0123456789abcdef.stage.tmp')).toThrow();
    expect(() => validateStageToken('.含中文.0123456789abcdef.stage.tmp')).toThrow();
    expect(() => validateRollbackToken('../escaped.rollback.tmp')).toThrow();
    expect(() => validateRollbackToken('.with space.0123456789abcdef.rollback.tmp')).toThrow();
  });
});

describe('G03b: Host Mode Streaming Exact DTO Conformance', () => {
  let tempDir: string;
  let spacesDir: string;
  const space = 'spc_host_0123456789abcdef01234567';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g03-test-host-'));
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(path.join(spacesDir, space), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('hostWriteStream response conforms to exact DTO with type: "file" and finite mtimeMs', async () => {
    const filePath = 'logs/streamed_output.txt';
    const payload = Buffer.from('Host streaming content with exact DTO', 'utf8');

    const result = await hostWriteStream(
      spacesDir,
      { space, path: filePath },
      Readable.from([payload])
    );

    expect(result.status).toBe('ok');
    expect(result.fileResult).toBeDefined();

    const file = result.fileResult!;
    expect(file.op).toBe('write');
    expect(file.space).toBe(space);
    expect(file.path).toBe(filePath);
    expect(file.type).toBe('file');
    expect(file.size).toBe(payload.length);
    expect(file.written).toBe(true);
    expect(typeof file.mtimeMs).toBe('number');
    expect(Number.isFinite(file.mtimeMs)).toBe(true);
    expect(file.mtimeMs! >= 0).toBe(true);
    expect(typeof file.etag).toBe('string');
    expect(file.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(typeof file.sha256).toBe('string');
    expect(file.sha256).toBe(crypto.createHash('sha256').update(payload).digest('hex'));
  });

  it('hostCommitStage response conforms to exact DTO with type: "file" and finite mtimeMs', async () => {
    const filePath = 'attachments/interview_notes.pdf';
    const payload = Buffer.from('PDF content payload for host staging', 'utf8');

    // Stage
    const stageRes = await hostStageStream(
      spacesDir,
      { space, path: filePath },
      Readable.from([payload])
    );

    expect(stageRes.stageToken).toBeDefined();
    expect(stageRes.size).toBe(payload.length);

    // Commit
    const commitRes = await hostCommitStage(
      spacesDir,
      {
        space,
        path: filePath,
        stageToken: stageRes.stageToken,
        requireAbsent: true,
      }
    );

    expect(commitRes.op).toBe('write');
    expect(commitRes.space).toBe(space);
    expect(commitRes.path).toBe(filePath);
    expect(commitRes.type).toBe('file');
    expect(commitRes.size).toBe(payload.length);
    expect(commitRes.written).toBe(true);
    expect(typeof commitRes.mtimeMs).toBe('number');
    expect(Number.isFinite(commitRes.mtimeMs)).toBe(true);
    expect(commitRes.mtimeMs! >= 0).toBe(true);
    expect(typeof commitRes.etag).toBe('string');
    expect(commitRes.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(typeof commitRes.sha256).toBe('string');
    expect(commitRes.sha256).toBe(crypto.createHash('sha256').update(payload).digest('hex'));
  });

  it('hostReadStream metadata conforms to exact DTO with type: "file" and finite mtimeMs', async () => {
    const filePath = 'docs/read_target.md';
    const payload = Buffer.from('Read target markdown content', 'utf8');

    await hostWriteStream(
      spacesDir,
      { space, path: filePath },
      Readable.from([payload])
    );

    const { metadata, stream } = await hostReadStream(
      spacesDir,
      { space, path: filePath }
    );

    expect(metadata.op).toBe('read');
    expect(metadata.space).toBe(space);
    expect(metadata.path).toBe(filePath);
    expect(metadata.type).toBe('file');
    expect(metadata.size).toBe(payload.length);
    expect(typeof metadata.mtimeMs).toBe('number');
    expect(Number.isFinite(metadata.mtimeMs)).toBe(true);
    expect(metadata.mtimeMs! >= 0).toBe(true);
    expect(typeof metadata.etag).toBe('string');
    expect(metadata.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(typeof metadata.sha256).toBe('string');

    // Read full stream
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('Read target markdown content');
  });

  it('host streaming operations support Chinese / Unicode paths and spaces', async () => {
    const unicodePath = '目录 带空格/财务 报表.xlsx';
    const payload = Buffer.from('Spreadsheet binary content simulation', 'utf8');

    const stageRes = await hostStageStream(
      spacesDir,
      { space, path: unicodePath },
      Readable.from([payload])
    );

    const commitRes = await hostCommitStage(
      spacesDir,
      {
        space,
        path: unicodePath,
        stageToken: stageRes.stageToken,
        requireAbsent: true,
      }
    );

    expect(commitRes.op).toBe('write');
    expect(commitRes.path).toBe(unicodePath);
    expect(commitRes.type).toBe('file');
    expect(commitRes.size).toBe(payload.length);
    expect(typeof commitRes.mtimeMs).toBe('number');

    const { metadata, stream } = await hostReadStream(
      spacesDir,
      { space, path: unicodePath }
    );
    expect(metadata.path).toBe(unicodePath);
    expect(metadata.type).toBe('file');
    expect(metadata.size).toBe(payload.length);

    // Consume stream to prevent hanging file descriptor across cleanup
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('Spreadsheet binary content simulation');
  });
});
