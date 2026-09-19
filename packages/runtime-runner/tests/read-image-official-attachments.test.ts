/**
 * Isolated Real-Protocol Tests for read_image & Official Attachments Capability
 *
 * Tests (0 real LLM calls):
 * 1. Booted Agent tool schemas contain official read_image.
 * 2. read_image execution on private JPEG fixture returns valid ContentBlocks
 *    ([text envelope, image block]) with exact bytes, sha256, and MIME.
 * 3. Provider serializer captures final Anthropic Messages wire payload with image count > 0.
 * 4. 10 synthetic valid JPEGs completely processed with deterministic SHA association.
 * 5. Strict security and format validation:
 *    - Corrupted / malformed image rejected
 *    - Non-existent file rejected
 *    - Path traversal / cross-workspace file access strictly rejected
 *
 * @module @enkeep/runtime-runner/tests/read-image-official-attachments.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { WorkspaceAttachmentStore } from '../src/runtime/workspace-attachments.js';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';

// Minimal valid 1x1 JPEG fixture (43 bytes base64)
const JPEG_1X1_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

/**
 * Creates a valid synthetic JPEG image with a unique comment marker to produce unique SHAs.
 */
function createSyntheticJpeg(uniqueSeed: string): Buffer {
  const comment = Buffer.from(`SYNTHETIC-JPEG-${uniqueSeed}`);
  const header = JPEG_1X1_BYTES.subarray(0, 2); // 0xFF, 0xD8
  const commentMarker = Buffer.from([0xff, 0xfe, (comment.length + 2) >> 8, (comment.length + 2) & 0xff]);
  const rest = JPEG_1X1_BYTES.subarray(2);
  return Buffer.concat([header, commentMarker, comment, rest]);
}

describe('read_image & Official Attachments Capability', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let spaceName: string;
  let spacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-img-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    spaceName = 'test-space';
    spacePath = path.join(aliceSpaces, spaceName);

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Verifies booted agent tools schemas contain read_image with valid parameter spec', async () => {
    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000001';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);

      const toolsService = agent.ctx.tools ?? (agent.ctx.get ? agent.ctx.get('tools') : undefined);
      expect(toolsService).toBeDefined();

      const schemas = toolsService.schemas(agent);
      const toolNames = schemas.map((s: any) => s.name);
      expect(toolNames).toContain('read_image');
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write');
      expect(toolNames).toContain('edit');

      const readImageSchema = schemas.find((s: any) => s.name === 'read_image');
      expect(readImageSchema).toBeDefined();
      expect(readImageSchema.parameters).toBeDefined();
      expect(readImageSchema.parameters.properties.file_path).toBeDefined();
      expect(readImageSchema.parameters.properties.file_path.type).toBe('string');
    } finally {
      await runtime.dispose();
    }
  });

  it('2. Executes read_image on JPEG fixture, returns ImageBlock, and verifies metadata', async () => {
    const testJpeg = createSyntheticJpeg('single-test');
    const expectedSha = createHash('sha256').update(testJpeg).digest('hex').toLowerCase();
    const filePath = 'photo.jpg';
    fs.writeFileSync(path.join(spacePath, filePath), testJpeg);

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000002';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);

      const readImageTool = agent.ctx.tools.get('read_image', agent);
      expect(readImageTool).toBeDefined();

      const execContext = {
        agent,
        signal: new AbortController().signal,
        callId: 'call_read_img_001',
        name: 'read_image',
      };

      const result = await readImageTool.execute({ file_path: filePath }, execContext);
      expect(result).toBeDefined();
      expect(result.path).toContain(filePath);
      expect(result.image).toBeDefined();
      expect(result.image.attachmentId).toBe(`sha256:${expectedSha}`);
      expect(result.image.mediaType).toBe('image/jpeg');
      expect(result.image.width).toBe(1);
      expect(result.image.height).toBe(1);
      expect(result.image.bytes).toBe(testJpeg.byteLength);

      // Verify tool render converts result to [TextBlock, ImageBlock]
      const rendered = readImageTool.output.render({ file_path: filePath }, result);
      expect(Array.isArray(rendered)).toBe(true);
      expect(rendered.length).toBe(2);

      const textBlock = rendered.find((b: any) => b.type === 'text');
      const imageBlock = rendered.find((b: any) => b.type === 'image');

      expect(textBlock).toBeDefined();
      expect(textBlock.text).toContain('photo.jpg');
      expect(textBlock.text).toContain('<type>image</type>');

      expect(imageBlock).toBeDefined();
      expect(imageBlock.attachment).toBeDefined();
      expect(imageBlock.attachment.attachmentId).toBe(`sha256:${expectedSha}`);
      expect(imageBlock.attachment.mediaType).toBe('image/jpeg');
    } finally {
      await runtime.dispose();
    }
  });

  it('3. Provider serializer captures final Anthropic Messages payload with image count > 0', async () => {
    const testJpeg = createSyntheticJpeg('serializer-test');
    const expectedSha = createHash('sha256').update(testJpeg).digest('hex').toLowerCase();
    const filePath = 'audit_diagram.jpg';
    fs.writeFileSync(path.join(spacePath, filePath), testJpeg);

    let capturedPayload: any = null;
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          capturedPayload = JSON.parse(body);
        } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test_001","type":"message","role":"assistant","content":[],"model":"claude-opus-5","usage":{"input_tokens":25,"output_tokens":0}}}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Image verified successfully."}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      });
    });

    const mockPort = await new Promise<number>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 8787);
      });
    });

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
      llmEnabled: true,
      llmBaseUrl: `http://127.0.0.1:${mockPort}/llm`,
      provider: 'cpa-claude',
      model: 'claude-opus-5',
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000003';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);

      // Execute read_image to produce real ImageBlock
      const readImageTool = agent.ctx.tools.get('read_image', agent);
      const execContext = {
        agent,
        signal: new AbortController().signal,
        callId: 'call_read_img_002',
        name: 'read_image',
      };

      const result = await readImageTool.execute({ file_path: filePath }, execContext);
      const renderedBlocks: ContentBlock[] = readImageTool.output.render({ file_path: filePath }, result);

      // Append tool-result user message carrying the ImageBlock to the agent's session
      const toolResultMessage = createUserMessage({
        content: [
          {
            type: 'tool-result',
            id: 'call_read_img_002' as any,
            name: 'read_image',
            content: renderedBlocks,
          },
        ],
        source: {
          kind: 'tool',
          callId: 'call_read_img_002' as any,
        },
      });

      // Followup to trigger provider serialization
      agent.followup(toolResultMessage);
      await agent.whenIdle();

      expect(capturedPayload).toBeDefined();
      expect(Array.isArray(capturedPayload.messages)).toBe(true);

      // Locate image blocks in serialized payload (checks top-level content and nested tool_result content)
      const allContentBlocks: any[] = capturedPayload.messages.flatMap((m: any) => {
        if (!Array.isArray(m.content)) return [];
        return m.content.flatMap((c: any) => (Array.isArray(c.content) ? c.content : [c]));
      });
      const imageBlocks = allContentBlocks.filter((b: any) => b.type === 'image');

      expect(imageBlocks.length).toBeGreaterThan(0);
      const firstImage = imageBlocks[0];
      expect(firstImage.type).toBe('image');
      expect(firstImage.source).toBeDefined();
      expect(firstImage.source.type).toBe('base64');
      expect(firstImage.source.media_type).toBe('image/jpeg');
      expect(firstImage.source.data).toBe(testJpeg.toString('base64'));
    } finally {
      await runtime.dispose();
      mockServer.close();
    }
  });

  it('4. Processes 10 synthetic valid JPEGs with deterministic SHA association and exact bytes', async () => {
    const imagesCount = 10;
    const generatedImages: Array<{ filename: string; sha: string; buffer: Buffer }> = [];

    const attDir = path.join(spacePath, '.attachments');
    fs.mkdirSync(attDir, { recursive: true, mode: 0o700 });

    for (let i = 0; i < imagesCount; i++) {
      const buf = createSyntheticJpeg(`batch-img-${i}`);
      const sha = createHash('sha256').update(buf).digest('hex').toLowerCase();
      const filename = `.attachments/${sha}/image_${i}.jpg`;
      const fullDir = path.join(spacePath, '.attachments', sha);
      fs.mkdirSync(fullDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(fullDir, `image_${i}.jpg`), buf);
      generatedImages.push({ filename, sha, buffer: buf });
    }

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000004';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const readImageTool = agent.ctx.tools.get('read_image', agent);

      // Execute read_image sequentially for all 10 images
      for (let i = 0; i < imagesCount; i++) {
        const item = generatedImages[i];
        const execContext = {
          agent,
          signal: new AbortController().signal,
          callId: `call_img_${i}`,
          name: 'read_image',
        };

        const result = await readImageTool.execute({ file_path: item.filename }, execContext);
        expect(result.path).toContain(item.filename);
        expect(result.image.attachmentId).toBe(`sha256:${item.sha}`);
        expect(result.image.mediaType).toBe('image/jpeg');
        expect(result.image.bytes).toBe(item.buffer.byteLength);
        expect(result.image.width).toBe(1);
        expect(result.image.height).toBe(1);
      }

      // Verify all 10 stored objects exist in attachment store
      const attachments = runtime.context.get('attachments');
      for (let i = 0; i < imagesCount; i++) {
        const item = generatedImages[i];
        const stored = await attachments.readImage({
          attachmentId: `sha256:${item.sha}` as any,
          mediaType: 'image/jpeg',
          bytes: item.buffer.byteLength,
          width: 1,
          height: 1,
        });
        expect(stored).toBeDefined();
        expect(Buffer.from(stored.data)).toEqual(item.buffer);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('5. Strictly rejects bad formats, corrupt files, missing files, and path traversal', async () => {
    // 5a. Corrupt file: JPEG extension with arbitrary binary text
    const badFilePath = 'corrupted.jpg';
    fs.writeFileSync(path.join(spacePath, badFilePath), Buffer.from('NOT-AN-IMAGE-CORRUPTED-HEADER'));

    // 5b. Another space file (path traversal attempt)
    const bobSpacePath = path.join(aliceSpaces, 'bob-space');
    fs.mkdirSync(bobSpacePath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bobSpacePath, 'secret.jpg'), JPEG_1X1_BYTES);

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000005';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const readImageTool = agent.ctx.tools.get('read_image', agent);

      const execContext = {
        agent,
        signal: new AbortController().signal,
        callId: 'call_sec_test',
        name: 'read_image',
      };

      // 5a: Corrupted file must throw
      await expect(
        readImageTool.execute({ file_path: badFilePath }, execContext)
      ).rejects.toThrow(/decode as a supported PNG\/JPEG\/WebP\/GIF image/i);

      // 5b: Missing file must throw not found
      await expect(
        readImageTool.execute({ file_path: 'does_not_exist.png' }, execContext)
      ).rejects.toThrow(/not found/i);

      // 5c: Empty file_path must throw
      await expect(
        readImageTool.execute({ file_path: '   ' }, execContext)
      ).rejects.toThrow(/file_path must be a non-empty string/i);

      // 5d: Cross-space traversal attempt must fail closed (outside workspace)
      await expect(
        readImageTool.execute({ file_path: '../bob-space/secret.jpg' }, execContext)
      ).rejects.toThrow();

      // 5e: Root path traversal attempt must fail closed
      await expect(
        readImageTool.execute({ file_path: '/etc/passwd' }, execContext)
      ).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
  });

  it('6. Throws ATTACHMENT_WRITE_FAILED on disk write permission/fault, evicts cache, and leaves no return', async () => {
    const testJpeg = createSyntheticJpeg('fault-perm-test');
    const expectedSha = createHash('sha256').update(testJpeg).digest('hex').toLowerCase();

    const faultHome = path.join(tmpDir, 'fault-alice', '.dsh');
    fs.mkdirSync(faultHome, { recursive: true, mode: 0o700 });

    const store = new WorkspaceAttachmentStore(new Context(), { dshHome: faultHome });
    const targetObjDir = path.join(store.root, 'objects', expectedSha.slice(0, 2));
    fs.mkdirSync(targetObjDir, { recursive: true, mode: 0o700 });

    // Make target directory read-only to simulate write fault / permission denied
    fs.chmodSync(targetObjDir, 0o400);

    try {
      await expect(
        store.saveImage({
          data: testJpeg,
          mediaType: 'image/jpeg',
          name: 'fail.jpg',
        })
      ).rejects.toMatchObject({
        code: 'ATTACHMENT_WRITE_FAILED',
      });

      // Restore permission for verification
      fs.chmodSync(targetObjDir, 0o700);

      // Verify memory cache was evicted on failure: readImage must fail with ATTACHMENT_NOT_FOUND
      await expect(
        store.readImage({
          attachmentId: `sha256:${expectedSha}` as any,
          mediaType: 'image/jpeg',
          bytes: testJpeg.byteLength,
          width: 1,
          height: 1,
        })
      ).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
    } finally {
      try { fs.chmodSync(targetObjDir, 0o700); } catch {}
    }
  });

  it('7. Reconstructs store and reads persisted image directly from disk with identical SHA and bytes', async () => {
    const testJpeg = createSyntheticJpeg('reconstruct-store-test');
    const expectedSha = createHash('sha256').update(testJpeg).digest('hex').toLowerCase();

    const durableHome = path.join(tmpDir, 'durable-alice', '.dsh');
    fs.mkdirSync(durableHome, { recursive: true, mode: 0o700 });

    // 1. First store instance saves image
    const store1 = new WorkspaceAttachmentStore(new Context(), { dshHome: durableHome });
    const ref = await store1.saveImage({
      data: testJpeg,
      mediaType: 'image/jpeg',
      name: 'durable.jpg',
    });
    expect(ref.attachmentId).toBe(`sha256:${expectedSha}`);

    // 2. Reconstruct completely fresh store instance without shared in-memory cache
    const store2 = new WorkspaceAttachmentStore(new Context(), { dshHome: durableHome });

    // 3. Read directly from disk via fresh store
    const stored = await store2.readImage(ref);
    expect(stored).toBeDefined();
    expect(stored.ref.attachmentId).toBe(`sha256:${expectedSha}`);
    expect(stored.data.byteLength).toBe(testJpeg.byteLength);

    const actualDiskSha = createHash('sha256').update(stored.data).digest('hex').toLowerCase();
    expect(actualDiskSha).toBe(expectedSha);
    expect(Buffer.from(stored.data)).toEqual(testJpeg);
  });
});
