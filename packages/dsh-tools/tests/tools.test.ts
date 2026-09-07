import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  createSendMessageTool,
  createSendFileTool,
  createCreateTaskTool,
  createCheckQuotaTool,
  FileSecurityError,
  PlatformToolError,
  PlatformToolErrorCode,
  setDefaultFileSecurityHooks,
  createSimulatedFdResolver,
  FIXED_QUOTA_METRICS,
} from '../src/index.js';
import type { PlatformClientService } from '../src/types.js';

function asPlatformToolError(err: unknown): PlatformToolError {
  if (err instanceof PlatformToolError) {
    return err;
  }
  throw err;
}

function asFileSecurityError(err: unknown): FileSecurityError {
  if (err instanceof FileSecurityError) {
    return err;
  }
  throw err;
}

describe('dsh-tools: tool implementations with Operational Truth', () => {
  let tempDir: string;
  let workspaceDir: string;
  let spacesDir: string;
  let spaceADir: string;
  let spaceBDir: string;
  let outsideDir: string;

  const validUuidV4 = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
  const validTaskId = 'task_0123456789abcdef0123456789abcdef';

  let agentAContext: ToolExecutionContext;
  let agentBContext: ToolExecutionContext;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-test-')));
    workspaceDir = path.join(tempDir, 'workspace');
    spacesDir = path.join(tempDir, 'spaces');
    spaceADir = path.join(spacesDir, 'space-a');
    spaceBDir = path.join(spacesDir, 'space-b');
    outsideDir = path.join(tempDir, 'outside');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });
    fs.mkdirSync(spaceADir, { recursive: true });
    fs.mkdirSync(spaceBDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    agentAContext = {
      agent: {
        id: 'agent_alpha',
        session: {
          header: {
            id: validSessionId,
            cwd: spaceADir,
          },
        },
      },
      sessionId: validSessionId,
    };

    agentBContext = {
      agent: {
        id: 'agent_beta',
        session: {
          header: {
            id: 'ses_0123456789abcdef0123456789abcdeb',
            cwd: spaceBDir,
          },
        },
      },
      sessionId: 'ses_0123456789abcdef0123456789abcdeb',
    };

    // Enable default test simulated resolver on macOS / test environments
    setDefaultFileSecurityHooks({
      resolveFdPath: createSimulatedFdResolver(),
    });
  });

  afterEach(() => {
    setDefaultFileSecurityHooks(undefined);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('send_platform_message tool', () => {
    it('executes via canonical client.request POST /api/messages with authoritative ID and timestamp', async () => {
      let requestedPath = '';
      let requestOpts: Record<string, unknown> | undefined;
      const mockClient: PlatformClientService = {
        async request(p, opts) {
          requestedPath = p;
          requestOpts = opts as Record<string, unknown>;
          return {
            status: 200,
            data: {
              success: true,
              messageId: 'msg-authoritative-12345',
              recipient: 'user-alice',
              timestamp: '2026-08-25T00:00:00.000Z',
            },
          };
        },
      };

      const tool = createSendMessageTool(() => mockClient);
      const res = await tool.execute({
        recipient: 'user-alice',
        content: 'Hello Alice!',
        metadata: { thread: 'general' },
      });

      expect(res.success).toBe(true);
      expect(res.messageId).toBe('msg-authoritative-12345');
      expect(res.recipient).toBe('user-alice');
      expect(res.timestamp).toBe('2026-08-25T00:00:00.000Z');
      expect(requestedPath).toBe('/api/messages');
      expect(requestOpts?.method).toBe('POST');
      expect(requestOpts?.body).toEqual({
        recipient: 'user-alice',
        content: 'Hello Alice!',
        metadata: { thread: 'general' },
      });
    });

    it('preserves raw recipient and content verbatim without trim mutation', async () => {
      let requestBody: any = null;
      const mockClient: PlatformClientService = {
        async request(_p, opts: any) {
          requestBody = opts?.body;
          return {
            status: 200,
            data: {
              success: true,
              messageId: 'msg-raw-1',
              timestamp: '2026-08-25T01:00:00.000Z',
            },
          };
        },
      };

      const tool = createSendMessageTool(() => mockClient);
      const rawRecipient = '  user-bob  ';
      const rawContent = '  padded content \n  ';
      await tool.execute({
        recipient: rawRecipient,
        content: rawContent,
      });

      expect(requestBody.recipient).toBe('  user-bob  ');
      expect(requestBody.content).toBe('  padded content \n  ');
    });

    it('fails closed when platform client is not available (PLATFORM_TOOL_UNAVAILABLE)', async () => {
      const tool = createSendMessageTool(() => undefined);
      try {
        await tool.execute({ recipient: 'user-alice', content: 'hi' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('fails closed when client has no request method (PLATFORM_TOOL_UNAVAILABLE)', async () => {
      const tool = createSendMessageTool(() => ({} as any));
      try {
        await tool.execute({ recipient: 'user-alice', content: 'hi' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when request returns missing messageId', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              messageId: '',
              timestamp: '2026-08-25T00:00:00Z',
            },
          };
        },
      };

      const tool = createSendMessageTool(() => mockClient);
      try {
        await tool.execute({ recipient: 'user-alice', content: 'hi' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
        expect(pErr.status).toBe(502);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when request returns missing timestamp', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              messageId: 'msg-123',
              timestamp: '',
            },
          };
        },
      };

      const tool = createSendMessageTool(() => mockClient);
      await expect(tool.execute({ recipient: 'user-alice', content: 'hi' })).rejects.toThrow(
        PlatformToolError
      );
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when request returns success=false', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: false,
              messageId: 'msg-123',
              timestamp: '2026-08-25T00:00:00Z',
            },
          };
        },
      };

      const tool = createSendMessageTool(() => mockClient);
      try {
        await tool.execute({ recipient: 'user-alice', content: 'hi' });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed when client.request returns HTTP error status or missing ID (no Date.now fake)', async () => {
      const mockClient500: PlatformClientService = {
        async request() {
          return { status: 500, data: { error: 'Internal Error' } };
        },
      };

      const tool500 = createSendMessageTool(() => mockClient500);
      await expect(tool500.execute({ recipient: 'user-alice', content: 'hi' })).rejects.toThrow(
        PlatformToolError
      );

      const mockClientNoId: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, timestamp: '2026-08-25T00:00:00Z' } };
        },
      };

      const toolNoId = createSendMessageTool(() => mockClientNoId);
      try {
        await toolNoId.execute({ recipient: 'user-alice', content: 'hi' });
        expect.unreachable('Should have thrown PlatformToolError without forging msg-Date.now()');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws error on empty recipient or content', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, messageId: 'msg-1', timestamp: '2026-08-25T00:00:00Z' } };
        },
      };
      const tool = createSendMessageTool(() => mockClient);
      await expect(tool.execute({ recipient: '', content: 'hi' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ recipient: 'alice', content: '' })).rejects.toThrow(TypeError);
    });
  });

  describe('send_file tool', () => {
    it('executes via canonical client.request POST /api/files with base64 payload, checksum, and sessionId', async () => {
      const testFile = path.join(spaceADir, 'data.csv');
      const testContent = 'a,b,c\n1,2,3';
      fs.writeFileSync(testFile, testContent);

      const expectedSha256 = crypto.createHash('sha256').update(testContent).digest('hex');
      const expectedBase64 = Buffer.from(testContent).toString('base64');

      let requestedPath = '';
      let requestBody: any = null;
      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestBody = opts?.body;
          return {
            status: 200,
            data: {
              success: true,
              fileId: 'file-authoritative-xyz-123',
              path: 'data.csv',
              size: Buffer.byteLength(testContent),
              recipient: 'user-charlie',
            },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      const res = await tool.execute(
        {
          recipient: 'user-charlie',
          path: 'data.csv',
          description: 'CSV metrics',
        },
        agentAContext
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('file-authoritative-xyz-123');
      expect(res.path).toBe('data.csv');
      expect(res.size).toBe(Buffer.byteLength(testContent));
      expect(res.recipient).toBe('user-charlie');
      expect((res as any).content).toBeUndefined(); // No base64 content in result
      expect(requestedPath).toBe('/api/files');

      expect(requestBody.recipient).toBe('user-charlie');
      expect(requestBody.filename).toBe('data.csv');
      expect(requestBody.checksum).toBe(`sha256:${expectedSha256}`);
      expect(requestBody.sha256).toBe(expectedSha256);
      expect(requestBody.encoding).toBe('base64');
      expect(requestBody.content).toBe(expectedBase64);
      expect(requestBody.description).toBe('CSV metrics');
      expect(requestBody.sessionId).toBe(validSessionId);
    });

    it('fails closed with TOOL_CONTEXT_UNAVAILABLE when called with root ctx / no agent context', async () => {
      const testFile = path.join(spaceADir, 'a.txt');
      fs.writeFileSync(testFile, 'hello');

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });

      // 1. Without context
      try {
        await tool.execute({ recipient: 'user-charlie', path: 'a.txt' });
        expect.unreachable('Should have thrown TOOL_CONTEXT_UNAVAILABLE when context is absent');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.TOOL_CONTEXT_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }

      // 2. Empty context without agent or session cwd
      try {
        await tool.execute({ recipient: 'user-charlie', path: 'a.txt' }, {} as any);
        expect.unreachable('Should have thrown TOOL_CONTEXT_UNAVAILABLE when session cwd is missing');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.TOOL_CONTEXT_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('checks platformClient operational BEFORE any filesystem read', async () => {
      // In zero-network scenario where client is missing, execute must fail with PLATFORM_TOOL_UNAVAILABLE
      // even if the requested file does not exist on disk
      const tool = createSendFileTool(() => undefined, { workspaceBoundaryRoot: spacesDir });
      try {
        await tool.execute({ recipient: 'user-charlie', path: 'non-existent-file.txt' }, agentAContext);
        expect.unreachable('Should have thrown PLATFORM_TOOL_UNAVAILABLE before file read');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('fails closed when client has no request method (PLATFORM_TOOL_UNAVAILABLE)', async () => {
      const testFile = path.join(spaceADir, 'a.txt');
      fs.writeFileSync(testFile, 'hello');

      const tool = createSendFileTool(() => ({} as any), { workspaceBoundaryRoot: spacesDir });
      try {
        await tool.execute({ recipient: 'user-charlie', path: 'a.txt' }, agentAContext);
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.status).toBe(503);
      }
    });

    it('fails with TypeError when workspaceBoundaryRoot is missing or not absolute', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };

      const toolNoWs = createSendFileTool(() => mockClient);
      await expect(toolNoWs.execute({ recipient: 'user', path: 'a.txt' }, agentAContext)).rejects.toThrow(TypeError);

      const toolRelWs = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: 'relative/dir' });
      await expect(toolRelWs.execute({ recipient: 'user', path: 'a.txt' }, agentAContext)).rejects.toThrow(TypeError);
    });

    it('rejects attempt to fallback operational cwd to spacesDir root directly', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });

      // Context cwd is set to spacesDir root directly
      const rootCwdContext: ToolExecutionContext = {
        agent: {
          id: 'root_agent',
          session: {
            header: {
              id: validSessionId,
              cwd: spacesDir,
            },
          },
        },
      };

      try {
        await tool.execute({ recipient: 'user', path: 'test.txt' }, rootCwdContext);
        expect.unreachable('Should have rejected operating directly on boundary root');
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('WORKSPACE_CANNOT_BE_BOUNDARY_ROOT');
        expect(secErr.status).toBe(403);
      }
    });

    it('Agent in SpaceA executes send_file within its space boundary', async () => {
      const fileInA = path.join(spaceADir, 'alpha_doc.txt');
      fs.writeFileSync(fileInA, 'Alpha Doc Content');

      const mockClient: PlatformClientService = {
        async request(_path, opts: any) {
          return {
            status: 200,
            data: {
              success: true,
              fileId: 'file_alpha_1',
              path: opts.body.path,
              size: opts.body.size,
              recipient: opts.body.recipient,
            },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      const res = await tool.execute(
        { recipient: 'dest_user', path: 'alpha_doc.txt' },
        agentAContext
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('file_alpha_1');
      expect(res.path).toBe('alpha_doc.txt');
    });

    it('Agent in SpaceA cannot access SpaceB files (traversal/inaccessible)', async () => {
      const fileInB = path.join(spaceBDir, 'beta_secret.txt');
      fs.writeFileSync(fileInB, 'Beta Secret Content');

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });

      // 1. Attempt relative traversal to SpaceB
      await expect(
        tool.execute(
          { recipient: 'dest_user', path: '../space-b/beta_secret.txt' },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);

      // 2. Attempt absolute path pointing to SpaceB
      await expect(
        tool.execute(
          { recipient: 'dest_user', path: fileInB },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('Subagent inherits parent SpaceA cwd and successfully sends file', async () => {
      const sharedFile = path.join(spaceADir, 'subagent_task.json');
      fs.writeFileSync(sharedFile, JSON.stringify({ subtask: 1 }));

      const mockClient: PlatformClientService = {
        async request(_path, opts: any) {
          return {
            status: 200,
            data: {
              success: true,
              fileId: 'file_subagent_99',
              path: opts.body.path,
              size: opts.body.size,
              recipient: opts.body.recipient,
            },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });

      // Subagent execution context inheriting parent spaceADir
      const subagentContext: ToolExecutionContext = {
        agent: {
          id: 'subagent_child_1',
          session: {
            header: {
              id: 'ses_child_0123456789abcdef012345',
              cwd: spaceADir,
            },
          },
        },
        sessionId: 'ses_child_0123456789abcdef012345',
      };

      const res = await tool.execute(
        { recipient: 'parent_user', path: 'subagent_task.json' },
        subagentContext
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('file_subagent_99');
      expect(res.path).toBe('subagent_task.json');
    });

    it('permits absolute path if strictly inside active SpaceA cwd', async () => {
      const fileInA = path.join(spaceADir, 'nested', 'doc.txt');
      fs.mkdirSync(path.join(spaceADir, 'nested'), { recursive: true });
      fs.writeFileSync(fileInA, 'Nested Doc');

      const mockClient: PlatformClientService = {
        async request(_path, opts: any) {
          return {
            status: 200,
            data: {
              success: true,
              fileId: 'file_nested_1',
              path: opts.body.path,
              size: opts.body.size,
              recipient: opts.body.recipient,
            },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      const res = await tool.execute(
        { recipient: 'dest', path: fileInA },
        agentAContext
      );

      expect(res.success).toBe(true);
      expect(res.fileId).toBe('file_nested_1');
      expect(res.path).toBe(path.join('nested', 'doc.txt'));
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when request returns missing fileId', async () => {
      const testFile = path.join(spaceADir, 'test.txt');
      fs.writeFileSync(testFile, 'data');

      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              fileId: '',
            },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      try {
        await tool.execute({ recipient: 'user-charlie', path: 'test.txt' }, agentAContext);
        expect.unreachable('Should have thrown PlatformToolError without forging ID');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
        expect(pErr.status).toBe(502);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE on HTTP failure in request', async () => {
      const testFile = path.join(spaceADir, 'test.txt');
      fs.writeFileSync(testFile, 'data');

      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 502,
            data: { error: 'Bad Gateway' },
          };
        },
      };

      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(tool.execute({ recipient: 'user-charlie', path: 'test.txt' }, agentAContext)).rejects.toThrow(
        PlatformToolError
      );
    });

    it('rejects path traversal attempting to send file outside workspace', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(
        tool.execute(
          {
            recipient: 'user-charlie',
            path: '../../outside.txt',
          },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('rejects symlinks pointing to outside files', async () => {
      const outsideFile = path.join(outsideDir, 'secret.env');
      fs.writeFileSync(outsideFile, 'SECRET=123');

      const symlinkFile = path.join(spaceADir, 'symlink.env');
      fs.symlinkSync(outsideFile, symlinkFile);

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(
        tool.execute(
          {
            recipient: 'user-charlie',
            path: 'symlink.env',
          },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('rejects symlinks pointing to inside files (strict policy)', async () => {
      const target = path.join(spaceADir, 'real.txt');
      fs.writeFileSync(target, 'inside real file');

      const symlink = path.join(spaceADir, 'link.txt');
      fs.symlinkSync(target, symlink);

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(
        tool.execute(
          {
            recipient: 'user-charlie',
            path: 'link.txt',
          },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('rejects intermediate directory symlink pointing outside workspace', async () => {
      const outsideDirSub = path.join(outsideDir, 'secrets');
      fs.mkdirSync(outsideDirSub, { recursive: true });
      fs.writeFileSync(path.join(outsideDirSub, 'secret.key'), 'SECRET_TOKEN');

      const symlinkParent = path.join(spaceADir, 'linked-parent');
      fs.symlinkSync(outsideDirSub, symlinkParent);

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(
        tool.execute(
          {
            recipient: 'user-charlie',
            path: 'linked-parent/secret.key',
          },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('rejects oversized files', async () => {
      const bigFile = path.join(spaceADir, 'big.bin');
      fs.writeFileSync(bigFile, Buffer.alloc(2000));

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, {
        workspaceBoundaryRoot: spacesDir,
        maxSizeBytes: 500,
      });

      await expect(
        tool.execute(
          {
            recipient: 'user-charlie',
            path: 'big.bin',
          },
          agentAContext
        )
      ).rejects.toThrow(FileSecurityError);
    });

    it('fails closed and throws FD_RESOLUTION_UNSUPPORTED when FD resolution is unsupported or returns null', async () => {
      const target = path.join(spaceADir, 'fail-closed.txt');
      fs.writeFileSync(target, 'fail closed test');

      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, {
        workspaceBoundaryRoot: spacesDir,
        hooks: {
          resolveFdPath: () => null,
        },
      });

      try {
        await tool.execute(
          {
            recipient: 'user-charlie',
            path: 'fail-closed.txt',
          },
          agentAContext
        );
        expect.unreachable('Should have thrown FileSecurityError');
      } catch (err: unknown) {
        const secErr = asFileSecurityError(err);
        expect(secErr.code).toBe('FD_RESOLUTION_UNSUPPORTED');
        expect(secErr.status).toBe(500);
      }
    });

    it('throws TypeError on invalid recipient or path arguments', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return { status: 200, data: { success: true, fileId: 'f1' } };
        },
      };
      const tool = createSendFileTool(() => mockClient, { workspaceBoundaryRoot: spacesDir });
      await expect(tool.execute({ recipient: '', path: 'a.txt' }, agentAContext)).rejects.toThrow(TypeError);
      await expect(tool.execute({ recipient: 'user', path: '' }, agentAContext)).rejects.toThrow(TypeError);
    });
  });

  describe('create_task tool', () => {
    it('declares JSON parameters schema with ONLY 4 required properties and additionalProperties: false', () => {
      const tool = createCreateTaskTool(() => ({}));
      const params = tool.parameters as any;

      expect(params.required).toEqual(['title', 'prompt', 'sessionId', 'idempotencyKey']);
      expect(params.additionalProperties).toBe(false);
      expect(Object.keys(params.properties)).toEqual(
        expect.arrayContaining(['title', 'prompt', 'sessionId', 'idempotencyKey', 'priority', 'dueDate'])
      );
      expect(params.properties.description).toBeUndefined();
      expect(params.properties.assignee).toBeUndefined();

      const outputSchema = tool.output?.schema as any;
      expect(outputSchema.additionalProperties).toBe(false);
      expect(outputSchema.required).toEqual(['success', 'taskId', 'title', 'status', 'isIdempotentHit']);
    });

    it('executes via canonical management API POST /api/manage/tasks with strict transport and factual isIdempotentHit', async () => {
      let requestedPath = '';
      let requestOpts: any = null;
      const exactPrompt = '  Line 1: check metrics\n  Line 2: report anomalies  ';

      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestOpts = opts;
          return {
            status: 201,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Review quarterly report',
                  status: 'pending',
                  priority: 'high',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      const res = await tool.execute({
        title: 'Review quarterly report',
        prompt: exactPrompt,
        sessionId: validSessionId,
        idempotencyKey: validUuidV4,
        priority: 'high',
      });

      expect(res.success).toBe(true);
      expect(res.taskId).toBe(validTaskId);
      expect(res.title).toBe('Review quarterly report');
      expect(res.status).toBe('pending');
      expect(res.isIdempotentHit).toBe(false);

      // Route and method verification
      expect(requestedPath).toBe('/api/manage/tasks');
      expect(requestOpts.method).toBe('POST');
      expect(requestOpts.headers).toEqual({
        'Idempotency-Key': validUuidV4,
      });

      // Strict payload verification: exact prompt bytes preserved, only title, prompt, sessionId, priority (no forbidden fields)
      expect(requestOpts.body).toEqual({
        title: 'Review quarterly report',
        prompt: exactPrompt,
        sessionId: validSessionId,
        priority: 'high',
      });
    });

    it('executes via canonical management API POST /api/manage/tasks with Idempotency-Key header and exact UTC dueDate', async () => {
      let requestedPath = '';
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestOpts = opts;
          return {
            status: 201,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Build release binary',
                  status: 'pending',
                  priority: 'urgent',
                  dueDate: '2026-09-01T12:00:00.000Z',
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: true,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      const res = await tool.execute({
        title: 'Build release binary',
        prompt: 'Execute docker build and export image',
        sessionId: validSessionId,
        idempotencyKey: validUuidV4,
        priority: 'urgent',
        dueDate: '2026-09-01T12:00:00.000Z',
      });

      expect(res.success).toBe(true);
      expect(res.taskId).toBe(validTaskId);
      expect(res.title).toBe('Build release binary');
      expect(res.status).toBe('pending');
      expect(res.isIdempotentHit).toBe(true);

      // Route and method verification
      expect(requestedPath).toBe('/api/manage/tasks');
      expect(requestOpts.method).toBe('POST');
      expect(requestOpts.headers).toEqual({
        'Idempotency-Key': validUuidV4,
      });

      // Body verification (only canonical allowed fields)
      expect(requestOpts.body).toEqual({
        title: 'Build release binary',
        prompt: 'Execute docker build and export image',
        sessionId: validSessionId,
        priority: 'urgent',
        dueDate: '2026-09-01T12:00:00.000Z',
      });
    });

    it('fails closed when client is missing (PLATFORM_TOOL_UNAVAILABLE in zero-network)', async () => {
      const tool = createCreateTaskTool(() => undefined);
      try {
        await tool.execute({
          title: 'Task',
          prompt: 'Execute work',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
      }
    });

    it('fails closed when client does not implement request transport (PLATFORM_TOOL_UNAVAILABLE)', async () => {
      const tool = createCreateTaskTool(() => ({}));
      try {
        await tool.execute({
          title: 'Task',
          prompt: 'Execute work',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
      }
    });

    it('fails closed and throws PLATFORM_TOOL_UNAVAILABLE when sessionId is missing or untrimmed or non-canonical pattern (no fake generation)', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      // Missing sessionId
      try {
        await tool.execute({
          title: 'Task without session',
          prompt: 'Execute task',
          sessionId: '',
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError for missing sessionId');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('sessionId');
      }

      // Untrimmed sessionId
      try {
        await tool.execute({
          title: 'Task with untrimmed session',
          prompt: 'Execute task',
          sessionId: `  ${validSessionId}  `,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError for untrimmed sessionId');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
      }

      // Context fallback rejected: sessionId must be explicitly passed in args
      try {
        await tool.execute(
          {
            title: 'Task relying on context sessionId',
            prompt: 'Execute task',
            idempotencyKey: validUuidV4,
          } as any,
          { sessionId: validSessionId }
        );
        expect.unreachable('Should have thrown PlatformToolError when sessionId is only in context');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
      }
    });

    it('fails closed and throws PLATFORM_TOOL_UNAVAILABLE when idempotencyKey is uppercase, untrimmed, or invalid (no fake UUIDv4 generation)', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);

      // Missing idempotencyKey
      try {
        await tool.execute({
          title: 'Task without idempotency key',
          prompt: 'Execute task',
          sessionId: validSessionId,
          idempotencyKey: '',
        });
        expect.unreachable('Should have thrown PlatformToolError for missing idempotencyKey');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('idempotencyKey');
      }

      // Uppercase idempotencyKey (must reject, no lowercasing before check)
      const uppercaseUuid = validUuidV4.toUpperCase();
      try {
        await tool.execute({
          title: 'Task with uppercase key',
          prompt: 'Execute task',
          sessionId: validSessionId,
          idempotencyKey: uppercaseUuid,
        });
        expect.unreachable('Should have thrown PlatformToolError for uppercase idempotencyKey');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('idempotencyKey');
      }

      // Untrimmed idempotencyKey (must reject, no trimming before check)
      try {
        await tool.execute({
          title: 'Task with untrimmed key',
          prompt: 'Execute task',
          sessionId: validSessionId,
          idempotencyKey: ` ${validUuidV4} `,
        });
        expect.unreachable('Should have thrown PlatformToolError for untrimmed idempotencyKey');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('idempotencyKey');
      }

      // Non-UUID string
      try {
        await tool.execute({
          title: 'Task with fake idempotency key',
          prompt: 'Execute task',
          sessionId: validSessionId,
          idempotencyKey: 'non-uuid-key-12345',
        });
        expect.unreachable('Should have thrown PlatformToolError for invalid idempotencyKey format');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('idempotencyKey');
      }

      // Context fallback rejected: idempotencyKey must be explicitly passed in args
      try {
        await tool.execute(
          {
            title: 'Task relying on context idempotencyKey',
            prompt: 'Execute task',
            sessionId: validSessionId,
          } as any,
          { idempotencyKey: validUuidV4 }
        );
        expect.unreachable('Should have thrown PlatformToolError when idempotencyKey is only in context');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.PLATFORM_TOOL_UNAVAILABLE);
        expect(pErr.message).toContain('idempotencyKey');
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when request returns missing taskId or non-canonical pattern', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: '',
                  title: 'New Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      try {
        await tool.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when status is not pending', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'running',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      try {
        await tool.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError for non-pending status');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE on raw response with no envelope or alias fallbacks', async () => {
      const mockClientRaw: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              id: validTaskId,
              title: 'New Task',
              status: 'pending',
            } as any,
          };
        },
      };

      const toolRaw = createCreateTaskTool(() => mockClientRaw);
      await expect(
        toolRaw.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(PlatformToolError);

      const mockClientAlias: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                taskId: validTaskId,
                title: 'New Task',
                status: 'pending',
                isIdempotentHit: false,
              } as any,
            },
          };
        },
      };

      const toolAlias = createCreateTaskTool(() => mockClientAlias);
      await expect(
        toolAlias.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(PlatformToolError);
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when extra keys are present on envelope, data, or task level', async () => {
      const mockClientExtraEnvelope: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
              extraMeta: 'forbidden',
            } as any,
          };
        },
      };
      const toolExtraEnv = createCreateTaskTool(() => mockClientExtraEnvelope);
      await expect(
        toolExtraEnv.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(PlatformToolError);

      const mockClientExtraTask: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                  updatedAt: '2026-08-25T00:00:00.000Z', // extra key
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };
      const toolExtraTask = createCreateTaskTool(() => mockClientExtraTask);
      await expect(
        toolExtraTask.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(PlatformToolError);
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when response title does not match (no fake fabrication)', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'Different Title From Response',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      try {
        await tool.execute({
          title: 'Requested Title',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError for mismatched response title');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when priority or dueDate or createdAt is invalid', async () => {
      const mockClientPriorityMismatch: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'pending',
                  priority: 'low', // requested high
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };
      const toolPri = createCreateTaskTool(() => mockClientPriorityMismatch);
      await expect(
        toolPri.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
          priority: 'high',
        })
      ).rejects.toThrow(PlatformToolError);

      const mockClientBadDate: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: 'not-an-iso-date',
                },
                isIdempotentHit: false,
              },
            },
          };
        },
      };
      const toolBadDate = createCreateTaskTool(() => mockClientBadDate);
      await expect(
        toolBadDate.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(PlatformToolError);
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when isIdempotentHit is not a strict boolean', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                task: {
                  id: validTaskId,
                  title: 'New Task',
                  status: 'pending',
                  priority: 'medium',
                  dueDate: null,
                  createdAt: '2026-08-25T00:00:00.000Z',
                },
                // missing isIdempotentHit
              } as any,
            },
          };
        },
      };

      const tool = createCreateTaskTool(() => mockClient);
      try {
        await tool.execute({
          title: 'New Task',
          prompt: 'Execute',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        });
        expect.unreachable('Should have thrown PlatformToolError for non-boolean isIdempotentHit');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('throws TypeError on untrimmed title, whitespace-only prompt, invalid priority, or non-UTC dueDate', async () => {
      const tool = createCreateTaskTool(() => ({}));

      // Untrimmed title
      await expect(
        tool.execute({ title: ' task ', prompt: 'work', sessionId: validSessionId, idempotencyKey: validUuidV4 })
      ).rejects.toThrow(TypeError);

      // Whitespace only prompt
      await expect(
        tool.execute({ title: 'task', prompt: '   ', sessionId: validSessionId, idempotencyKey: validUuidV4 })
      ).rejects.toThrow(TypeError);

      // Invalid priority
      await expect(
        tool.execute({
          title: 'task',
          prompt: 'work',
          priority: 'super-urgent' as any,
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(TypeError);

      // Non-canonical / non-UTC dueDate
      await expect(
        tool.execute({
          title: 'task',
          prompt: 'work',
          dueDate: '2026-09-01',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(TypeError);

      await expect(
        tool.execute({
          title: 'task',
          prompt: 'work',
          dueDate: 'invalid-date',
          sessionId: validSessionId,
          idempotencyKey: validUuidV4,
        })
      ).rejects.toThrow(TypeError);
    });
  });

  describe('check_quota tool', () => {
    it('declares JSON parameters and output schema with additionalProperties: false and strict types', () => {
      const tool = createCheckQuotaTool(() => ({}));
      const params = tool.parameters as any;
      expect(params.additionalProperties).toBe(false);
      expect(params.properties.resource.enum).toEqual([
        'tokens',
        'messages',
        'turns',
        'storage_bytes',
        'api_calls',
        'all',
      ]);

      const outputSchema = tool.output?.schema as any;
      expect(outputSchema.additionalProperties).toBe(false);
      expect(outputSchema.required).toEqual([
        'allowed',
        'usage',
        'activeReservations',
        'limit',
        'remaining',
        'resetAt',
      ]);
    });

    it('executes via typed checkQuota method and strictly validates fixed metrics non-negative safe ints and mathematical remaining equality', async () => {
      const mockClient: PlatformClientService = {
        async checkQuota(payload) {
          return {
            allowed: true,
            limit: {
              tokens: 100000,
              messages: 500,
              turns: 200,
              storage_bytes: 10485760,
              api_calls: 1000,
            },
            usage: {
              tokens: 1500,
              messages: 10,
              turns: 5,
              storage_bytes: 51200,
              api_calls: 25,
            },
            activeReservations: {
              tokens: 500,
              messages: 0,
              turns: 0,
              storage_bytes: 0,
              api_calls: 0,
            },
            remaining: {
              tokens: 98000,
              messages: 490,
              turns: 195,
              storage_bytes: 10434560,
              api_calls: 975,
            },
            resetAt: '2026-09-01T00:00:00.000Z',
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      const res = await tool.execute({ resource: 'tokens' });

      expect(res.allowed).toBe(true);
      expect(res.usage.tokens).toBe(1500);
      expect(res.activeReservations.tokens).toBe(500);
      expect(res.limit.tokens).toBe(100000);
      expect(res.remaining.tokens).toBe(98000);
      expect(Object.keys(res.limit)).toEqual(
        expect.arrayContaining(['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'])
      );
      expect(res.resetAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('fails closed when checkQuota returns non-fixed metric keys (e.g. cpu, memory)', async () => {
      const mockClient: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: { cpu_shares: 10, tokens: 0, messages: 0, turns: 0, storage_bytes: 0 },
            activeReservations: { cpu_shares: 0, tokens: 0, messages: 0, turns: 0, storage_bytes: 0 },
            limit: { cpu_shares: 100, tokens: 0, messages: 0, turns: 0, storage_bytes: 0 },
            remaining: { cpu_shares: 90, tokens: 0, messages: 0, turns: 0, storage_bytes: 0 },
            resetAt: null,
          } as any;
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      try {
        await tool.execute({});
        expect.unreachable('Should have thrown PlatformToolError for non-fixed metric');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed when checkQuota returns extra or missing keys for fixed metrics', async () => {
      const mockClientExtra: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: { tokens: 10, messages: 5, turns: 1, storage_bytes: 100, api_calls: 1, extra_metric: 0 }, // extra
            activeReservations: { tokens: 0, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            limit: { tokens: 100, messages: 50, turns: 20, storage_bytes: 1000, api_calls: 10 },
            remaining: { tokens: 90, messages: 45, turns: 19, storage_bytes: 900, api_calls: 9 },
            resetAt: null,
          } as any;
        },
      };
      const toolExtra = createCheckQuotaTool(() => mockClientExtra);
      await expect(toolExtra.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);
    });

    it('fails closed when checkQuota returns negative numbers or non-integers or mathematically inconsistent remaining', async () => {
      // Negative usage
      const mockNegative: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: { tokens: -5, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            activeReservations: { tokens: 0, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            limit: { tokens: 100, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            remaining: { tokens: 105, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            resetAt: null,
          } as any;
        },
      };
      const toolNegative = createCheckQuotaTool(() => mockNegative);
      await expect(toolNegative.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);

      // Remaining does not match limit - (usage + activeReservations) (100 - (10 + 0) = 90, but returns 50)
      const mockInconsistentRemaining: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: { tokens: 10, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            activeReservations: { tokens: 0, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            limit: { tokens: 100, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            remaining: { tokens: 50, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            resetAt: null,
          } as any;
        },
      };
      const toolInconsistent = createCheckQuotaTool(() => mockInconsistentRemaining);
      await expect(toolInconsistent.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);
    });

    it('fails closed when checkQuota returns non-canonical or non-ISO resetAt string', async () => {
      const mockClient: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: { tokens: 10, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            activeReservations: { tokens: 0, messages: 0, turns: 0, storage_bytes: 0, api_calls: 0 },
            limit: { tokens: 100, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            remaining: { tokens: 90, messages: 100, turns: 100, storage_bytes: 100, api_calls: 100 },
            resetAt: '2026-09-01', // not exact ISO UTC representation
          } as any;
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      await expect(tool.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);
    });

    it('executes via canonical GET /api/manage/quota/check management API with fixed metrics telemetry and separates activeReservations', async () => {
      let requestedPath = '';
      let requestOpts: any = null;
      const mockClient: PlatformClientService = {
        async request(p, opts: any) {
          requestedPath = p;
          requestOpts = opts;
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: true,
                limit: {
                  tokens: 100000,
                  messages: 500,
                  turns: 200,
                  storage_bytes: 10485760,
                  api_calls: 1000,
                },
                usage: {
                  tokens: 2500,
                  messages: 10,
                  turns: 5,
                  storage_bytes: 51200,
                  api_calls: 25,
                },
                activeReservations: {
                  tokens: 500,
                  messages: 0,
                  turns: 0,
                  storage_bytes: 0,
                  api_calls: 0,
                },
                remaining: {
                  tokens: 97000,
                  messages: 490,
                  turns: 195,
                  storage_bytes: 10434560,
                  api_calls: 975,
                },
                resetAt: '2026-09-01T00:00:00.000Z',
              },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      const res = await tool.execute({ resource: 'tokens' });

      expect(requestedPath).toBe('/api/manage/quota/check');
      expect(requestOpts.method).toBe('GET');
      expect(requestOpts.query).toEqual({
        metrics: 'all',
      });

      expect(res.allowed).toBe(true);
      expect(res.limit).toEqual({
        tokens: 100000,
        messages: 500,
        turns: 200,
        storage_bytes: 10485760,
        api_calls: 1000,
      });
      expect(res.usage).toEqual({
        tokens: 2500,
        messages: 10,
        turns: 5,
        storage_bytes: 51200,
        api_calls: 25,
      });
      expect(res.activeReservations).toEqual({
        tokens: 500,
        messages: 0,
        turns: 0,
        storage_bytes: 0,
        api_calls: 0,
      });
      // 100000 - (2500 used + 500 reserved) = 97000 remaining
      expect(res.remaining.tokens).toBe(97000);
      expect(res.resetAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when platform returns legacy items list instead of exact telemetry', async () => {
      const mockClientLegacy: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                items: [
                  {
                    userId: 'usr-bob',
                    limits: [{ resource: 'tokens', limit: 100000 }],
                    usage: [{ resource: 'tokens', usedAmount: 2500 }],
                    activeReservations: [{ resource: 'tokens', amount: 500, status: 'reserved' }],
                  },
                ],
              },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClientLegacy);
      await expect(tool.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);
    });

    it('returns allowed=false when resource limit is exceeded (usage + activeReservations >= limit)', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: false,
                limit: {
                  tokens: 100000,
                  messages: 50,
                  turns: 200,
                  storage_bytes: 10485760,
                  api_calls: 1000,
                },
                usage: {
                  tokens: 2500,
                  messages: 48,
                  turns: 5,
                  storage_bytes: 51200,
                  api_calls: 25,
                },
                activeReservations: {
                  tokens: 500,
                  messages: 5,
                  turns: 0,
                  storage_bytes: 0,
                  api_calls: 0,
                },
                remaining: {
                  tokens: 97000,
                  messages: 0,
                  turns: 195,
                  storage_bytes: 10434560,
                  api_calls: 975,
                },
                resetAt: null,
              },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      const res = await tool.execute({ resource: 'messages' });

      expect(res.allowed).toBe(false);
      expect(res.limit.messages).toBe(50);
      expect(res.usage.messages).toBe(48);
      expect(res.activeReservations.messages).toBe(5);
      expect(res.remaining.messages).toBe(0);
    });

    it('evaluates overall allowed status across all 5 fixed metrics when resource="all" or undefined', async () => {
      const mockClient: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: true,
                limit: {
                  tokens: 10000,
                  messages: 100,
                  turns: 50,
                  storage_bytes: 1000000,
                  api_calls: 200,
                },
                usage: {
                  tokens: 2000,
                  messages: 20,
                  turns: 10,
                  storage_bytes: 50000,
                  api_calls: 10,
                },
                activeReservations: {
                  tokens: 0,
                  messages: 0,
                  turns: 0,
                  storage_bytes: 0,
                  api_calls: 0,
                },
                remaining: {
                  tokens: 8000,
                  messages: 80,
                  turns: 40,
                  storage_bytes: 950000,
                  api_calls: 190,
                },
                resetAt: '2026-09-01T00:00:00.000Z',
              },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      const res = await tool.execute({ resource: 'all' });

      expect(res.allowed).toBe(true);
      expect(Object.keys(res.limit)).toEqual(
        expect.arrayContaining(['tokens', 'messages', 'turns', 'storage_bytes', 'api_calls'])
      );
      expect(res.remaining['tokens']).toBe(8000);
      expect(res.remaining['messages']).toBe(80);
      expect(res.remaining['turns']).toBe(40);
    });

    it('fails closed when checking all metrics and any of the 5 fixed metrics is missing in limits', async () => {
      const mockClientMissingTurn: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: true,
                limit: {
                  tokens: 10000,
                  messages: 100,
                  // missing turns, storage_bytes, api_calls
                },
                usage: {
                  tokens: 2000,
                  messages: 20,
                },
                activeReservations: {
                  tokens: 0,
                  messages: 0,
                },
                remaining: {
                  tokens: 8000,
                  messages: 80,
                },
                resetAt: null,
              },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClientMissingTurn);
      await expect(tool.execute({ resource: 'all' })).rejects.toThrow(PlatformToolError);
    });

    it('rejects invalid resource names outside the 5 fixed metrics (tokens, messages, turns, storage_bytes, api_calls, all)', async () => {
      const tool = createCheckQuotaTool(() => ({}));
      await expect(tool.execute({ resource: 'unknown_metric' })).rejects.toThrow(TypeError);
      await expect(tool.execute({ resource: 'cpu_shares' })).rejects.toThrow(TypeError);
    });

    it('fails closed and throws INVALID_PLATFORM_RESPONSE when platform returns missing fields or extra fields', async () => {
      const mockClientMissing: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: true,
                usage: { tokens: 100 },
                // missing limit, remaining, activeReservations, resetAt
              },
            },
          };
        },
      };

      const toolMissing = createCheckQuotaTool(() => mockClientMissing);
      try {
        await toolMissing.execute({ resource: 'tokens' });
        expect.unreachable('Should have thrown PlatformToolError for missing quota fields');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }

      const mockClientExtraEnvelope: PlatformClientService = {
        async request() {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                allowed: true,
                limit: { tokens: 100 },
                usage: { tokens: 10 },
                activeReservations: { tokens: 0 },
                remaining: { tokens: 90 },
                resetAt: null,
              },
              extraKey: 'forbidden',
            },
          };
        },
      };

      const toolExtraEnv = createCheckQuotaTool(() => mockClientExtraEnvelope);
      try {
        await toolExtraEnv.execute({ resource: 'tokens' });
        expect.unreachable('Should have thrown PlatformToolError for extra envelope keys');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed when client is missing or lacks methods (PLATFORM_TOOL_UNAVAILABLE in zero-network)', async () => {
      const toolNoClient = createCheckQuotaTool(() => undefined);
      await expect(toolNoClient.execute({})).rejects.toThrow(PlatformToolError);

      const toolEmptyClient = createCheckQuotaTool(() => ({}));
      await expect(toolEmptyClient.execute({})).rejects.toThrow(PlatformToolError);
    });

    it('fails closed when checkQuota returns missing required fields (INVALID_PLATFORM_RESPONSE)', async () => {
      const mockClient: PlatformClientService = {
        async checkQuota() {
          return {
            allowed: true,
            usage: {},
            activeReservations: {},
            limit: {},
            // missing remaining
          } as any;
        },
      };

      const tool = createCheckQuotaTool(() => mockClient);
      try {
        await tool.execute({});
        expect.unreachable('Should have thrown PlatformToolError');
      } catch (err: unknown) {
        const pErr = asPlatformToolError(err);
        expect(pErr.code).toBe(PlatformToolErrorCode.INVALID_PLATFORM_RESPONSE);
      }
    });

    it('fails closed when request returns error status or success=false envelope', async () => {
      const mockClient500: PlatformClientService = {
        async request() {
          return {
            status: 500,
            data: {
              success: false,
              error: { code: 'INTERNAL_ERROR', message: 'Quota engine down' },
            },
          };
        },
      };

      const tool = createCheckQuotaTool(() => mockClient500);
      await expect(tool.execute({ resource: 'tokens' })).rejects.toThrow(PlatformToolError);
    });
  });
});
